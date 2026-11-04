import http.server
import socketserver
import base64
import hmac
import os
import ssl
import json
import yaml
import socket
import subprocess
import threading
from urllib.parse import urlparse, parse_qs, unquote
try:
    import sdnotify
except ImportError:
    sdnotify = None

from socketserver import ThreadingMixIn

with open('argonvr.yaml', 'r', encoding='utf-8') as f:
    config = yaml.safe_load(f)

SETTINGS = config.get('SETTINGS', {})
CAMERAS = config.get('CAMERAS', {})

USERNAME = str(SETTINGS.get('WEB_USER', 'admin'))
PASSWORD = str(SETTINGS.get('WEB_PASS', 'secret'))
STORE_DIR = SETTINGS.get('STORE_DIR', './recordings')
BASE_DIR = SETTINGS.get('BASE_DIR', './cameras')
WEB_DIR = SETTINGS.get('WEB_DIR', './web')

ABS_STORE_DIR = os.path.abspath(STORE_DIR)
ABS_BASE_DIR = os.path.abspath(BASE_DIR)
ABS_WEB_DIR = os.path.abspath(WEB_DIR)
STORE_DIR_NAME = os.path.basename(os.path.normpath(STORE_DIR))
BASE_DIR_NAME = os.path.basename(os.path.normpath(BASE_DIR))

PORT = int(SETTINGS.get('PORT', 8000))
CAMERA_COUNT = len(CAMERAS)

SSL_CERT = SETTINGS.get('SSL_CERT_PATH', '')
SSL_KEY = SETTINGS.get('SSL_KEY_PATH', '')
LOG_HTTP_REQUESTS = SETTINGS.get('LOG_HTTP_REQUESTS', False)


class ThreadedHTTPServer(ThreadingMixIn, socketserver.TCPServer):
    """Handle requests in a separate thread with bounded concurrency and per-thread TLS handshakes."""
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64

    def __init__(self, server_address, RequestHandlerClass, ssl_context=None):
        super().__init__(server_address, RequestHandlerClass)
        self.ssl_context = ssl_context
        self._thread_sema = threading.BoundedSemaphore(64)

    def process_request_thread(self, request, client_address):
        """Performs the TLS handshake inside the worker thread with a strict timeout
        so a stalled client connection can never block the main accept() loop."""
        with self._thread_sema:
            try:
                request.settimeout(10)
                if self.ssl_context is not None:
                    request = self.ssl_context.wrap_socket(request, server_side=True)
                self.finish_request(request, client_address)
            except (ConnectionResetError, BrokenPipeError, socket.timeout, ssl.SSLError, OSError):
                pass
            except Exception:
                self.handle_error(request, client_address)
            finally:
                self.shutdown_request(request)


class SecureAuthHandler(http.server.SimpleHTTPRequestHandler):

    # Kills zombie threads if the client hangs for 10 seconds
    timeout = 10

    # Ensure correct HLS & media MIME types across both Linux and macOS
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.m3u8': 'application/vnd.apple.mpegurl',
        '.ts': 'video/mp2t',
        '.mp4': 'video/mp4',
        '.vtt': 'text/vtt',
        '.svg': 'image/svg+xml',
        '.json': 'application/json',
    }

    def __init__(self, *args, **kwargs):
        # Override the default directory to strictly serve static files from WEB_DIR
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    def address_string(self):
        """Prevents reverse DNS lookups that cause initial connection lag."""
        return self.client_address[0]

    def handle(self):
        try:
            super().handle()
        except (ConnectionResetError, BrokenPipeError, socket.timeout, ssl.SSLError, OSError):
            pass
        except Exception as e:
            print(f"Unexpected error: {e}")

    def log_message(self, format, *args):
        request_path = getattr(self, 'path', '')
        quiet_extensions = ('.ts', '.m3u8', '.mp4', '.json', '.jpg', '.vtt', '.js')
        if not LOG_HTTP_REQUESTS and any(ext in request_path for ext in quiet_extensions):
            return
        super().log_message(format, *args)

    def end_headers(self):
        """Intercept header generation to inject custom headers before flushing."""
        clean_path = getattr(self, 'path', '').split('?', 1)[0].split('#', 1)[0]

        # Apply no-store to HTML, root, live HLS playlists, and dynamic JSON endpoints
        if (
                clean_path.endswith('.html')
                or clean_path == '/'
                or clean_path.endswith('/stream.m3u8')
                or clean_path in ('/history', '/available_dates', '/cameracount', '/basedir')
        ):
            self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')

        super().end_headers()

    @staticmethod
    def _safe_join(root_abs, relative_path):
        """Resolves a relative path inside root_abs and blocks directory traversal."""
        rel = unquote(relative_path).lstrip('/')
        candidate = os.path.abspath(os.path.join(root_abs, rel))
        if candidate == root_abs or candidate.startswith(root_abs + os.sep):
            return candidate
        return root_abs

    def translate_path(self, path):
        clean_path = path.split('?', 1)[0].split('#', 1)[0]

        # 1. Keep recordings explicitly mapped to STORE_DIR
        if clean_path.startswith('/recordings/'):
            relative_path = clean_path[len('/recordings/'):]
            return self._safe_join(ABS_STORE_DIR, relative_path)
        if STORE_DIR_NAME != 'recordings' and clean_path.startswith(f'/{STORE_DIR_NAME}/'):
            relative_path = clean_path[len(f'/{STORE_DIR_NAME}/'):]
            return self._safe_join(ABS_STORE_DIR, relative_path)

        # 2. Ensure active camera streams explicitly map to BASE_DIR outside of WEB_DIR
        if clean_path.startswith(f'/{BASE_DIR_NAME}/'):
            relative_path = clean_path[len(f'/{BASE_DIR_NAME}/'):]
            return self._safe_join(ABS_BASE_DIR, relative_path)

        # 3. Everything else defaults to being securely served out of WEB_DIR
        return super().translate_path(path)

    def do_AUTHHEAD(self):
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="ArgoNVR Secure Access"')
        self.send_header("Content-type", "text/html")
        self.end_headers()

    def _is_authenticated(self):
        auth_header = self.headers.get('Authorization')
        if not auth_header:
            return False
        try:
            auth_type, encoded_credentials = auth_header.split(' ', 1)
            if auth_type.lower() != 'basic':
                return False
            decoded_credentials = base64.b64decode(encoded_credentials).decode('utf-8')
            username, password = decoded_credentials.split(':', 1)
            return (
                    hmac.compare_digest(username, USERNAME)
                    and hmac.compare_digest(password, PASSWORD)
            )
        except Exception:
            return False

    def _send_json(self, payload, status=200):
        data = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def serve_range(self, filepath, range_header):
        try:
            with open(filepath, 'rb') as f:
                fs = os.fstat(f.fileno())
                file_len = fs.st_size

                byte_range = range_header.split('=')[1].split('-')
                start = int(byte_range[0]) if byte_range[0] else 0
                end = int(byte_range[1]) if (len(byte_range) > 1 and byte_range[1]) else file_len - 1
                end = min(end, file_len - 1)

                if start >= file_len or start > end:
                    self.send_error(416, "Requested Range Not Satisfiable")
                    return

                length = end - start + 1
                self.send_response(206)
                self.send_header('Content-Type', 'video/mp4')
                self.send_header('Accept-Ranges', 'bytes')
                self.send_header('Content-Range', f'bytes {start}-{end}/{file_len}')
                self.send_header('Content-Length', str(length))
                self.end_headers()

                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (ConnectionResetError, BrokenPipeError, socket.timeout, ssl.SSLError):
            pass
        except Exception as e:
            self.send_error(500, f"Server Error: {e}")

    def do_GET(self):
        parsed_url = urlparse(self.path)
        path_no_query = parsed_url.path
        query_params = parse_qs(parsed_url.query)

        if path_no_query == '/health':
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.send_header('Content-Length', '2')
            self.end_headers()
            self.wfile.write(b"OK")
            return

        # --- PWA Whitelist ---
        # Allow manifest, service worker, and icons to bypass Basic Auth
        # so the browser can validate the PWA in the background.
        if path_no_query in ('/manifest.json', '/sw.js') or path_no_query.startswith('/icons/'):
            super().do_GET()
            return
        # ---------------------

        if not self._is_authenticated():
            self.do_AUTHHEAD()
            self.wfile.write(b"Authentication required.")
            return

        if path_no_query == '/history':
            req_date = query_params.get('date', [None])[0]
            req_cam = query_params.get('cam', [None])[0]

            if not req_date:
                self.send_error(400, "Missing 'date' parameter")
                return

            safe_date = os.path.basename(req_date)
            response_data = {}

            if req_cam:
                safe_cam = os.path.basename(req_cam)
                history_path = os.path.join(ABS_STORE_DIR, safe_cam, f'history_{safe_date}.json')
                cam_history = []
                if os.path.exists(history_path):
                    try:
                        with open(history_path, 'r', encoding='utf-8') as f:
                            cam_history = json.load(f)
                    except Exception as e:
                        print(f"Error reading {history_path}: {e}")
                response_data[safe_cam] = cam_history
            else:
                try:
                    if os.path.exists(ABS_STORE_DIR):
                        for cam_dir in os.listdir(ABS_STORE_DIR):
                            cam_path = os.path.join(ABS_STORE_DIR, cam_dir)
                            if os.path.isdir(cam_path):
                                history_path = os.path.join(cam_path, f'history_{safe_date}.json')
                                cam_history = []
                                if os.path.exists(history_path):
                                    try:
                                        with open(history_path, 'r', encoding='utf-8') as f:
                                            cam_history = json.load(f)
                                    except Exception as e:
                                        print(f"Error reading {history_path}: {e}")
                                response_data[cam_dir] = cam_history
                except Exception as e:
                    print(f"Error reading history directories: {e}")

            self._send_json(response_data)
            return

        if path_no_query == '/available_dates':
            dates = set()
            try:
                if os.path.exists(ABS_STORE_DIR):
                    for cam_dir in os.listdir(ABS_STORE_DIR):
                        cam_path = os.path.join(ABS_STORE_DIR, cam_dir)
                        if os.path.isdir(cam_path):
                            for file in os.listdir(cam_path):
                                if file.startswith('history_') and file.endswith('.json'):
                                    date_str = file[8:16]
                                    if date_str.isdigit():
                                        dates.add(date_str)
            except Exception as e:
                print(f"Error reading available dates: {e}")

            self._send_json(sorted(dates))
            return

        if path_no_query == '/cameracount':
            self._send_json({"count": CAMERA_COUNT})
            return

        if path_no_query == '/basedir':
            self._send_json({"baseDir": BASE_DIR})
            return

        filepath = self.translate_path(path_no_query)

        if path_no_query.endswith(('.m3u8', '.ts', '.mp4', '.json', '.jpg', '.vtt')):
            if not os.path.exists(filepath):
                self.send_error(404)
                return

        range_header = self.headers.get('Range')
        if path_no_query.endswith('.mp4') and range_header:
            self.serve_range(filepath, range_header)
            return

        super().do_GET()

    def do_POST(self):
        parsed_url = urlparse(self.path)
        path_no_query = parsed_url.path

        if not self._is_authenticated():
            self.do_AUTHHEAD()
            self.wfile.write(b"Authentication required.")
            return

        if path_no_query == '/api/system/reboot':
            try:
                self._send_json({"message": "Rebooting host machine..."}, status=200)
                self.wfile.flush()

                def _trigger_reboot():
                    try:
                        subprocess.run(["sudo", "reboot"], check=True)
                    except Exception as err:
                        print(f"Failed to execute reboot: {err}")

                threading.Timer(0.5, _trigger_reboot).start()
            except Exception as e:
                self._send_json({"error": str(e)}, status=500)
            return

        self.send_error(404, "Endpoint not found")


if __name__ == "__main__":
    tls_context = None
    if SSL_CERT and SSL_KEY and os.path.exists(SSL_CERT) and os.path.exists(SSL_KEY):
        tls_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls_context.load_cert_chain(certfile=SSL_CERT, keyfile=SSL_KEY)

    with ThreadedHTTPServer(("", PORT), SecureAuthHandler, ssl_context=tls_context) as httpd:
        if tls_context is not None:
            print(f"🔒 Secure HTTPS ArgoNVR server running on port {PORT}")
        else:
            print(f"🔓 ArgoNVR server running on port {PORT} (No SSL configured)")

        print(f"📂 Storage mapped to: {STORE_DIR}")
        print(f"📷 Cameras discovered from config: {CAMERA_COUNT}")

        # Notify systemd that the boot process is complete
        if sdnotify is not None:
            try:
                notifier = sdnotify.SystemdNotifier()
                notifier.notify("READY=1")
                print("Systemd notified: READY=1")
            except Exception as e:
                print(f"Warning: Could not notify systemd ({e})")

        httpd.serve_forever()