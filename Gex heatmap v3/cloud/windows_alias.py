"""Legacy localhost bookmark -> private cloud. No SDK, database or calculations."""
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
URL='https://instance-20261115-035258.tail29d8e5.ts.net/'
class Redirect(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.headers.get('Host') not in ('127.0.0.1:8766','localhost:8766'):
            self.send_error(403);return
        self.send_response(302);self.send_header('Location',URL);self.send_header('Cache-Control','no-store');self.end_headers()
    def log_message(self,*args):pass
if __name__=='__main__':ThreadingHTTPServer(('127.0.0.1',8766),Redirect).serve_forever()
