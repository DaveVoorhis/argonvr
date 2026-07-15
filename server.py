import http.server
import socketserver
import base64
import os
import configparser

config = configparser.ConfigParser()
config.read('argonvr.cfg')

USERNAME = config['SETTINGS'].get('WEB_USER', 'admin')
PASSWORD = config['SETTINGS'].get('WEB_PASS', 'secret')

PORT = 8000

class SecureAuthHandler(http.server.SimpleHTTPRequestHandler):
    def do_AUTHHEAD(self):
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="ArgoNVR Secure Access"')
        self.send_header("Content-type", "text/html")
        self.end_headers()

    def serve_range(self, filepath, range_header):
        try:
            f = open(filepath, 'rb')
            fs = os.fstat(f.fileno())
            file_len = fs.st_size
            
            byte_range = range_header.split('=')[1].split('-')
            start = int(byte_range[0])
            end = int(byte_range[1]) if byte_range[1] else file_len - 1
            
            if start >= file_len:
                self.send_error(416, "Requested Range Not Satisfiable")
                f.close()
                return
                
            length = end - start + 1
            
            self.send_response(206)
            self.send_header('Content-Type', 'video/mp4')
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Range', f'bytes {start}-{end}/{file_len}')
            self.send_header('Content-Length', str(length))
            self.end_headers()
            
            f.seek(start)
            bytes_left = length
            while bytes_left > 0:
                chunk_size = min(65536, bytes_left)
                chunk = f.read(chunk_size)
                if not chunk: break
                try:
                    self.wfile.write(chunk)
                except (ConnectionResetError, BrokenPipeError):
                    break 
                bytes_left -= len(chunk)
            f.close()
        except Exception as e:
            self.send_error(500, f"Server Error: {str(e)}")

    def do_GET(self):
        # Strip query parameters for safe extension checking
        path_no_query = self.path.split('?')[0]

        if path_no_query == '/logo.svg':
            try:
                with open('logo.svg', 'rb') as f:
                    self.send_response(200)
                    self.send_header('Content-Type', 'image/svg+xml')
                    self.end_headers()
                    self.wfile.write(f.read())
                return
            except FileNotFoundError:
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
                    range_header = self.headers.get('Range')
                    if path_no_query.endswith('.mp4') and range_header:
                        filepath = self.translate_path(self.path)
                        if os.path.exists(filepath):
                            self.serve_range(filepath, range_header)
                            return
                            
                    super().do_GET()
                    return
        except Exception:
            pass 
            
        self.do_AUTHHEAD()
        self.wfile.write(b"Invalid username or password.")

if __name__ == "__main__":
    with http.server.ThreadingHTTPServer(("", PORT), SecureAuthHandler) as httpd:
        print(f"🔒 Secure ArgoNVR web server running on port {PORT} (Multi-threaded)")
        httpd.serve_forever()