"""RoboSim Lite 로컬 서버 (start.bat에서 실행).

python -m http.server 대신 쓰는 이유:
- 캐시 금지 헤더를 보내고, 앱 페이지를 열 때 사이트 캐시를 비워서(Clear-Site-Data) 업데이트 후에도
  브라우저가 예전 JS 파일을 섞어 쓰지 않게 한다 (경로 계획 Worker의 모듈 버전 불일치 방지).
- .js 파일의 MIME 타입을 text/javascript로 고정한다 (Windows 레지스트리 설정에 따라 text/plain이 되면 모듈이 로드되지 않음).
- 포트가 이미 사용 중이면 알려 주고, 서버가 뜬 뒤에 브라우저를 연다.
"""
import http.server
import os
import socket
import sys
import threading
import webbrowser

ARGS = [a for a in sys.argv[1:] if not a.startswith('--')]
PORT = int(ARGS[0]) if ARGS else 8300  # v3.0.0 기본 포트 (v1.0.0 = 8000, v1.1.0 = 8011, v1.1.1 = 8111, v1.1.2 = 8112, v2.0.0 = 8200 → 브라우저 저장 데이터 분리)
OPEN_BROWSER = '--no-browser' not in sys.argv
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.json': 'application/json',
        '.css': 'text/css',
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        # 앱 페이지를 열 때마다 이 사이트의 HTTP 캐시를 비운다: 이전 버전 실행 때 캐시된 JS가 남아 있으면
        # 메인 화면은 새 파일, 경로 계획 Worker는 예전 파일을 쓰는 버전 불일치가 생기기 때문 (저장 데이터는 지우지 않음)
        if self.path.split('?')[0] in ('/', '/index.html'):
            self.send_header('Clear-Site-Data', '"cache"')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # 요청 로그 생략 (창을 깔끔하게)


class Server(http.server.ThreadingHTTPServer):
    allow_reuse_address = False  # Windows에서 같은 포트에 서버가 중복으로 뜨지 않도록


def port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(('127.0.0.1', port)) == 0


def main():
    url = f'http://localhost:{PORT}/'
    if port_in_use(PORT):
        print(f'[안내] 포트 {PORT}을 이미 다른 프로그램(이전에 연 start.bat 창 등)이 사용 중입니다.')
        print('       열려 있는 다른 start.bat 창을 모두 닫은 뒤 다시 실행하세요.')
        input('Enter를 누르면 닫힙니다...')
        sys.exit(1)
    server = Server(('', PORT), Handler)
    print(f'RoboSim Lite 실행 중: {url}')
    print('이 창을 닫으면 서버가 종료됩니다.')
    if OPEN_BROWSER:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
