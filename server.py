import http.server
import socketserver
import base64
import os
import configparser
import ssl
import json
import socket

# Add ThreadingMixIn to enable concurrent request handling
from socketserver import ThreadingMixIn

config = configparser.ConfigParser()
config.read('argonvr.cfg')

USERNAME = config['SETTINGS'].get('WEB_USER', 'admin')
PASSWORD = config['SETTINGS'].get('WEB_PASS', 'secret')
STORE_DIR = config['SETTINGS'].get('STORE_DIR', './recordings')

PORT = int(config['SETTINGS'].get('PORT', '8000'))

# Dynamically count the number of cameras defined in the config
if config.has_section('CAMERAS'):
    CAMERA_COUNT = len(config.items('CAMERAS'))
else:
    CAMERA_COUNT = 0

SSL_CERT = config['SETTINGS'].get('SSL_CERT_PATH')
SSL_KEY = config['SETTINGS'].get('SSL_KEY_PATH')
LOG_HTTP_REQUESTS = config.getboolean('SETTINGS', 'LOG_HTTP_REQUESTS', fallback=False)

# Define the new Threaded Server class
class ThreadedHTTPServer(ThreadingMixIn, socketserver.TCPServer):
    """Handle requests in a separate thread to prevent blocking."""
    daemon_threads = True
    allow_reuse_address = True

class SecureAuthHandler(http.server.SimpleHTTPRequestHandler):

    # Kills zombie threads if the client hangs for 10 seconds
    timeout = 10

    def address_string(self):
        """Prevents reverse DNS lookups that cause initial connection lag."""
        return self.client_address[0]

    def handle(self):
        try:
            super().handle()
        except (ConnectionResetError, BrokenPipeError, socket.timeout): # Added socket.timeout here as well
            pass
        except ssl.SSLError:
            pass
        except Exception as e:
            print(f"Unexpected error: {e}")

    def log_message(self, format, *args):
        request_path = getattr(self, 'path', '')
        quiet_extensions = ['.ts', '.m3u8', '.mp4', '.json']
        if not LOG_HTTP_REQUESTS and any(ext in request_path for ext in quiet_extensions):
            return
        super().log_message(format, *args)

    def translate_path(self, path):
        if path.startswith('/recordings/'):
            relative_path = path[len('/recordings/'):]
            return os.path.join(STORE_DIR, relative_path)
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
        path_no_query = self.path.split('?')[0]
        filepath = self.translate_path(path_no_query)

        if path_no_query.endswith(('.m3u8', '.ts', '.mp4')):
            if not os.path.exists(filepath):
                self.send_error(404)
                return

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

                    # Intercept the /history endpoint dynamically using STORE_DIR
                    if path_no_query == '/history':
                        history_path = os.path.join(STORE_DIR, 'history.json')
                        if os.path.exists(history_path):
                            with open(history_path, 'rb') as f:
                                data = f.read()
                            self.send_response(200)
                            self.send_header('Content-Type', 'application/json')
                            self.send_header('Content-Length', str(len(data)))
                            self.end_headers()
                            self.wfile.write(data)
                        else:
                            # Return empty JSON object if file doesn't exist yet
                            self.send_response(200)
                            self.send_header('Content-Type', 'application/json')
                            self.end_headers()
                            self.wfile.write(b"{}")
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
    # Swapped TCPServer for ThreadedHTTPServer
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
        httpd.serve_forever()