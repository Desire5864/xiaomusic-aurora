"""给 aurora 主题用的「刮削」触发服务，跑在 xiaomusic 容器里。

只做一件事：收到 POST /scrape 就在容器内跑 /app/tools/scrape.py --auto，
并把输出缓存下来供前端轮询。参数全部固定，不接受外部命令。

  GET  /health   -> {"ok": true}
  GET  /status   -> {"running": bool, "exit": int|null, "lines": [...]}
  POST /scrape   -> 启动一次（已在跑则 409）
"""

import json
import os
import subprocess
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen

PORT = int(os.getenv("TRIGGER_PORT", "8099"))
TOKEN = os.getenv("TRIGGER_TOKEN", "").strip()
REFRESH_URL = os.getenv("XIAOMUSIC_BASE", "http://127.0.0.1:8090") + "/refreshmusictag"
PY = "/app/.venv/bin/python3"
SCRIPT = "/app/tools/scrape.py"

_lock = threading.Lock()
_state = {"running": False, "exit": None, "started": 0, "finished": 0}
_lines = deque(maxlen=400)


def _run(limit=None):
    cmd = [PY, SCRIPT, "--auto"]
    if limit:
        cmd += ["--limit", str(limit)]

    with _lock:
        _state.update(running=True, exit=None, started=time.time(), finished=0)
    _lines.clear()

    code = -1
    try:
        p = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1, cwd="/app",
        )
        for line in p.stdout:
            _lines.append(line.rstrip())
        code = p.wait()
    except Exception as e:  # noqa: BLE001
        _lines.append("启动失败: %r" % e)

    with _lock:
        _state.update(running=False, exit=code, finished=time.time())

    # 写完顺手让 xiaomusic 重新读标签，前端不用再点「刷新标签缓存」
    if code == 0:
        try:
            urlopen(Request(REFRESH_URL, data=b"{}", method="POST"), timeout=60)
            _lines.append("已刷新 xiaomusic 标签缓存")
        except Exception as e:  # noqa: BLE001
            _lines.append("刷新标签缓存失败：%s" % e)


class Handler(BaseHTTPRequestHandler):
    server_version = "aurora-scrape/1.0"

    def log_message(self, *a):  # 静音
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin") or "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Vary", "Origin")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._json(200, {"ok": True})
        if self.path.startswith("/status"):
            with _lock:
                data = dict(_state)
            data["lines"] = list(_lines)[-60:]
            return self._json(200, data)
        self._json(404, {"error": "not found"})

    def do_POST(self):
        # 有 body 也读掉，避免 keep-alive 连接受污染
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n:
                self.rfile.read(n)
        except Exception:
            pass

        if TOKEN and self.headers.get("X-Token") != TOKEN:
            return self._json(401, {"error": "bad token"})
        if not self.path.startswith("/scrape"):
            return self._json(404, {"error": "not found"})

        with _lock:
            if _state["running"]:
                return self._json(409, {"error": "已经在跑了"})
            _state["running"] = True  # 先占位，避免并发启动两个

        threading.Thread(target=_run, daemon=True).start()
        self._json(200, {"started": True})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
