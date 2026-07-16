import http.server
import socketserver
import base64
import os
import configparser

config = configparser.ConfigParser()
config.read('argonvr.cfg')

USERNAME = config['SETTINGS'].get('WEB_USER', 'admin')
PASSWORD = config['SETTINGS'].get('WEB_PASS', 'secret')
STORE_DIR = config['SETTINGS'].get('STORE_DIR', './recordings')

# Read the PORT setting and convert it to an integer (defaults to 8000 if missing)
PORT = int(config['SETTINGS'].get('PORT', '8000'))

class SecureAuthHandler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        # Route requests for recordings to the configured storage directory
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
                chunk = f.read(min(bytes_left, 8192))
                if not chunk:
                    break
                self.wfile.write(chunk)
                bytes_left -= len(chunk)
            f.close()
        except Exception as e:
            self.send_error(500, f"Server Error: {e}")

    def do_GET(self):
        path_no_query = self.path.split('?')[0]
        
        # We need to map the filepath explicitly for the range checker too
        if path_no_query.startswith('/recordings/'):
            filepath = self.translate_path(path_no_query)
        else:
            filepath = self.translate_path(self.path)
            
        if path_no_query.endswith(('.m3u8', '.ts', '.mp4')):
            try:
                os.stat(filepath)
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
        print(f"📂 Storage mapped to: {STORE_DIR}")
        httpd.serve_forever()