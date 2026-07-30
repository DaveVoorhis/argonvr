import http.server
import socketserver
import base64
import os
import ssl
import json
import yaml
import socket
from urllib.parse import urlparse, parse_qs
try:
    import sdnotify
except ImportError:
    sdnotify = None

# Add ThreadingMixIn to enable concurrent request handling
from socketserver import ThreadingMixIn

with open('argonvr.yaml', 'r') as f:
    config = yaml.safe_load(f)

SETTINGS = config.get('SETTINGS', {})
CAMERAS = config.get('CAMERAS', {})

USERNAME = SETTINGS.get('WEB_USER', 'admin')
PASSWORD = SETTINGS.get('WEB_PASS', 'secret')
STORE_DIR = SETTINGS.get('STORE_DIR', './recordings')
BASE_DIR = SETTINGS.get('BASE_DIR', './cameras')
WEB_DIR = SETTINGS.get('WEB_DIR', './web')

PORT = int(SETTINGS.get('PORT', 8000))
CAMERA_COUNT = len(CAMERAS)

SSL_CERT = SETTINGS.get('SSL_CERT_PATH', '')
SSL_KEY = SETTINGS.get('SSL_KEY_PATH', '')
LOG_HTTP_REQUESTS = SETTINGS.get('LOG_HTTP_REQUESTS', False)

# Define the new Threaded Server class
class ThreadedHTTPServer(ThreadingMixIn, socketserver.TCPServer):
    """Handle requests in a separate thread to prevent blocking."""
    daemon_threads = True
    allow_reuse_address = True

class SecureAuthHandler(http.server.SimpleHTTPRequestHandler):

    # Kills zombie threads if the client hangs for 10 seconds
    timeout = 10

    def __init__(self, *args, **kwargs):
        # Override the default directory to strictly serve static files from WEB_DIR
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    def address_string(self):
        """Prevents reverse DNS lookups that cause initial connection lag."""
        return self.client_address[0]

    def handle(self):
        try:
            super().handle()
        except (ConnectionResetError, BrokenPipeError, socket.timeout):
            pass
        except ssl.SSLError:
            pass
        except Exception as e:
            print(f"Unexpected error: {e}")

    def log_message(self, format, *args):
        request_path = getattr(self, 'path', '')
        # Added .js to prevent Service Worker polling from spamming the logs
        quiet_extensions = ['.ts', '.m3u8', '.mp4', '.json', '.jpg', '.vtt', '.js']
        if not LOG_HTTP_REQUESTS and any(ext in request_path for ext in quiet_extensions):
            return
        super().log_message(format, *args)

    def translate_path(self, path):
        # Strip query string and fragments for path matching
        clean_path = path.split('?', 1)[0].split('#', 1)[0]

        # 1. Keep recordings explicitly mapped to STORE_DIR
        if clean_path.startswith('/recordings/'):
            relative_path = clean_path[len('/recordings/'):]
            return os.path.join(STORE_DIR, relative_path)

        # 2. Ensure active camera streams explicitly map to BASE_DIR outside of WEB_DIR
        base_dir_name = os.path.basename(os.path.normpath(BASE_DIR))
        if clean_path.startswith(f'/{base_dir_name}/'):
            relative_path = clean_path[len(f'/{base_dir_name}/'):]
            return os.path.join(BASE_DIR, relative_path)

        # 3. Everything else defaults to being securely served out of WEB_DIR
        return super().translate_path(path)

    def do_AUTHHEAD(self):
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="ArgoNVR Secure Access"')
        self.send_header("Content-type", "text/html")
        self.end_headers()

    def serve_range(self, filepath, range_header):
        try:
            with open(filepath, 'rb') as f:
                fs = os.fstat(f.fileno())
                file_len = fs.st_size

                byte_range = range_header.split('=')[1].split('-')
                start = int(byte_range[0])
                end = int(byte_range[1]) if byte_range[1] else file_len - 1

                if start >= file_len:
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
                # Increased buffer size to 64KB for better throughput
                while True:
                    chunk = f.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except Exception as e:
            self.send_error(500, f"Server Error: {e}")

    def do_GET(self):
        parsed_url = urlparse(self.path)
        path_no_query = parsed_url.path
        query_params = parse_qs(parsed_url.query)

        filepath = self.translate_path(path_no_query)

        if path_no_query == '/health':
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.end_headers()
            self.wfile.write(b"OK")
            return

        if path_no_query.endswith(('.m3u8', '.ts', '.mp4', '.json', '.jpg', '.vtt')):
            if not os.path.exists(filepath):
                self.send_error(404)
                return

        # --- PWA Whitelist ---
        # Allow manifest, service worker, and icons to bypass Basic Auth
        # so the browser can validate the PWA in the background.
        if path_no_query in ('/manifest.json', '/sw.js') or path_no_query.startswith('/icons/'):
            super().do_GET()
            return
        # ---------------------

        auth_header = self.headers.get('Authorization')
        if not auth_header:
            self.do_AUTHHEAD()
            self.wfile.write(b"Authentication required.")
            return

        try:
            auth_type, encoded_credentials = auth_header.split(' ', 1)
            if auth_type.lower() == 'basic':
                decoded_credentials = base64.b64decode(encoded_credentials).decode('utf-8')
                username, password = decoded_credentials.split(':', 1)

                if username == USERNAME and password == PASSWORD:
                    if path_no_query == '/history':
                        req_date = query_params.get('date', [None])[0]
                        req_cam = query_params.get('cam', [None])[0]

                        if not req_date or not req_cam:
                            self.send_error(400, "Missing 'date' or 'cam' parameters")
                            return

                        history_path = os.path.join(STORE_DIR, req_cam, f'history_{req_date}.json')
                        cam_history = []

                        if os.path.exists(history_path):
                            try:
                                with open(history_path, 'r') as f:
                                    cam_history = json.load(f)
                            except Exception as e:
                                print(f"Error reading {history_path}: {e}")

                        # Maintain original {"cam_id": [{clip}]} payload structure
                        response_data = {req_cam: cam_history}
                        data = json.dumps(response_data).encode('utf-8')

                        self.send_response(200)
                        self.send_header('Content-Type', 'application/json')
                        self.send_header('Content-Length', str(len(data)))
                        self.end_headers()
                        self.wfile.write(data)
                        return

                    # Intercept the /available_dates endpoint
                    if path_no_query == '/available_dates':
                        dates = set()
                        try:
                            if os.path.exists(STORE_DIR):
                                for cam_dir in os.listdir(STORE_DIR):
                                    cam_path = os.path.join(STORE_DIR, cam_dir)
                                    if os.path.isdir(cam_path):
                                        for file in os.listdir(cam_path):
                                            if file.startswith('history_') and file.endswith('.json'):
                                                # Extract YYYYMMDD from history_YYYYMMDD.json
                                                date_str = file[8:16]
                                                dates.add(date_str)
                        except Exception as e:
                            print(f"Error reading available dates: {e}")

                        data = json.dumps(list(dates)).encode('utf-8')
                        self.send_response(200)
                        self.send_header('Content-Type', 'application/json')
                        self.send_header('Content-Length', str(len(data)))
                        self.end_headers()
                        self.wfile.write(data)
                        return

                    # Intercept the /cameracount endpoint
                    if path_no_query == '/cameracount':
                        data = json.dumps({"count": CAMERA_COUNT}).encode('utf-8')
                        self.send_response(200)
                        self.send_header('Content-Type', 'application/json')
                        self.send_header('Content-Length', str(len(data)))
                        self.end_headers()
                        self.wfile.write(data)
                        return

                    # Intercept the /basedir endpoint
                    if path_no_query == '/basedir':
                        data = json.dumps({"baseDir": BASE_DIR}).encode('utf-8')
                        self.send_response(200)
                        self.send_header('Content-Type', 'application/json')
                        self.send_header('Content-Length', str(len(data)))
                        self.end_headers()
                        self.wfile.write(data)
                        return

                    range_header = self.headers.get('Range')
                    if path_no_query.endswith('.mp4') and range_header:
                        self.serve_range(filepath, range_header)
                        return
                    super().do_GET()
                    return
        except Exception:
            pass
        self.do_AUTHHEAD()
        self.wfile.write(b"Invalid username or password.")

if __name__ == "__main__":
    with ThreadedHTTPServer(("", PORT), SecureAuthHandler) as httpd:
        if SSL_CERT and SSL_KEY and os.path.exists(SSL_CERT) and os.path.exists(SSL_KEY):
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(certfile=SSL_CERT, keyfile=SSL_KEY)
            httpd.socket = context.wrap_socket(httpd.socket, server_side=True)
            print(f"🔒 Secure HTTPS ArgoNVR server running on port {PORT}")
        else:
            print(f"🔓 ArgoNVR server running on port {PORT} (No SSL configured)")

        print(f"📂 Storage mapped to: {STORE_DIR}")
        print(f"📷 Cameras discovered from config: {CAMERA_COUNT}")

        # Notify systemd that the boot process is complete
        try:
            notifier = sdnotify.SystemdNotifier()
            notifier.notify("READY=1")
            print("Systemd notified: READY=1")
        except Exception as e:
            print(f"Warning: Could not notify systemd ({e})")

        httpd.serve_forever()