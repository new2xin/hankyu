from __future__ import annotations

import json
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
LINES_FILE = ROOT / "data" / "lines.json"
AUTH_CONFIG_FILE = ROOT / "config" / "app-auth.json"
API_ORIGIN = "https://cdn.hankyu-app.com"
BUILD_CONFIG = ROOT / "analysis" / "decompiled" / "sources" / "jp" / "co" / "hankyu" / "data" / "BuildConfig.java"
VALID_LINE_IDS = {item["id"] for item in json.loads(LINES_FILE.read_text(encoding="utf-8"))}


def auth_token() -> str:
    token = os.environ.get("HANKYU_APP_AUTH_TOKEN", "").strip()
    if token:
        return token
    if AUTH_CONFIG_FILE.is_file():
        try:
            config = json.loads(AUTH_CONFIG_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError("config/app-auth.json を読み込めません。") from exc
        token = config.get("app_auth_token") if isinstance(config, dict) else None
        if isinstance(token, str) and token.strip():
            return token.strip()
    if BUILD_CONFIG.is_file():
        source = BUILD_CONFIG.read_text(encoding="utf-8")
        match = re.search(r'APP_AUTH_TOKEN\s*=\s*"([^"]+)"', source)
        if match:
            return match.group(1)
    raise RuntimeError(
        "阪急アプリのAPIトークンが見つかりません。"
        " HANKYU_APP_AUTH_TOKEN 環境変数を設定してください。"
    )


class HankyuHandler(BaseHTTPRequestHandler):
    server_version = "HankyuWeb/1.0"

    def send_bytes(self, body: bytes, content_type: str, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, value: object, status: int = 200) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_bytes(body, "application/json; charset=utf-8", status)

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/api/lines":
            try:
                self.send_bytes(LINES_FILE.read_bytes(), "application/json; charset=utf-8")
            except OSError as exc:
                self.send_json({"error": f"路線データを読めません: {exc}"}, 500)
            return

        if parsed.path == "/api/positions":
            self.handle_positions(parsed.query)
            return

        self.serve_static(parsed.path)

    def handle_positions(self, query: str) -> None:
        values = parse_qs(query)
        try:
            line_id = int(values.get("line_id", [""])[0])
        except (TypeError, ValueError):
            self.send_json({"error": "line_id は1〜10の路線IDを指定してください。"}, 400)
            return
        if line_id not in VALID_LINE_IDS:
            self.send_json({"error": "指定された路線IDはありません。"}, 400)
            return

        url = f"{API_ORIGIN}/v1/train/positions/?train_position_line_id={line_id}"
        try:
            request = Request(
                url,
                headers={
                    "x-auth-token": auth_token(),
                    "Accept": "application/json",
                    "User-Agent": "HankyuWeb/1.0",
                },
                method="GET",
            )
            with urlopen(request, timeout=15) as response:
                payload = json.loads(response.read().decode("utf-8"))
            if not isinstance(payload, dict) or not isinstance(payload.get("positions"), list):
                self.send_json({"error": "阪急APIから想定外の応答が返りました。"}, 502)
                return
            self.send_json(payload)
        except HTTPError as exc:
            self.send_json({"error": f"阪急APIの応答: HTTP {exc.code}"}, 502)
        except URLError as exc:
            self.send_json({"error": f"阪急APIに接続できません: {exc.reason}"}, 502)
        except (TimeoutError, OSError) as exc:
            self.send_json({"error": f"阪急APIへの接続に失敗しました: {exc}"}, 502)
        except json.JSONDecodeError:
            self.send_json({"error": "阪急APIがJSON以外の応答を返しました。"}, 502)
        except RuntimeError as exc:
            self.send_json({"error": str(exc)}, 503)

    def serve_static(self, request_path: str) -> None:
        relative = "index.html" if request_path in ("", "/") else request_path.lstrip("/")
        candidate = (PUBLIC / relative).resolve()
        try:
            candidate.relative_to(PUBLIC.resolve())
        except ValueError:
            self.send_json({"error": "Not found"}, 404)
            return
        if not candidate.is_file():
            self.send_json({"error": "Not found"}, 404)
            return
        content_types = {
            ".css": "text/css; charset=utf-8",
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".svg": "image/svg+xml",
        }
        self.send_bytes(candidate.read_bytes(), content_types.get(candidate.suffix.lower(), "application/octet-stream"))

    def log_message(self, format_string: str, *args: object) -> None:
        print(f"[{self.log_date_time_string()}] {format_string % args}")


def main() -> None:
    host = os.environ.get("HANKYU_HOST", "127.0.0.1")
    port = int(os.environ.get("HANKYU_PORT", "18731"))
    server = ThreadingHTTPServer((host, port), HankyuHandler)
    print(f"阪急 車両位置ビュー: http://{host}:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nサーバーを終了します。", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
