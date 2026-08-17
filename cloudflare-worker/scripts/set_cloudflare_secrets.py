#!/usr/bin/env python3
"""Set Cloudflare secrets without writing the app password to disk."""

from __future__ import annotations

import base64
import getpass
import hashlib
import json
import os
import secrets
import subprocess
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent.parent
WRANGLER = BASE_DIR / "node_modules" / ".bin" / "wrangler"
VAPID_FILE = BASE_DIR / "private" / "vapid-converted.json"


def base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def put_secret(name: str, value: str) -> None:
    environment = os.environ.copy()
    environment["WRANGLER_LOG_PATH"] = str(BASE_DIR / ".wrangler" / "wrangler-secrets.log")
    result = subprocess.run(
        [str(WRANGLER), "secret", "put", name],
        cwd=BASE_DIR,
        env=environment,
        input=value + "\n",
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode:
        raise SystemExit(f"設定 {name} 失敗：{result.stderr.strip() or result.stdout.strip()}")
    print(f"{name}: 已安全設定")


password = getpass.getpass("請輸入網站密碼：")
confirmation = getpass.getpass("請再輸入一次：")
if not password or password != confirmation:
    raise SystemExit("兩次密碼不一致，未設定任何 Cloudflare secret。")

# Cloudflare Workers Web Crypto rejects PBKDF2 counts above 100,000.
iterations = 100_000
salt = os.urandom(16)
digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations, dklen=32)
password_hash = f"pbkdf2_sha256${iterations}${base64url(salt)}${base64url(digest)}"
password = ""
confirmation = ""

vapid = json.loads(VAPID_FILE.read_text(encoding="utf-8"))
put_secret("APP_PASSWORD_HASH", password_hash)
put_secret("SESSION_SECRET", secrets.token_urlsafe(48))
put_secret("VAPID_PUBLIC_KEY", vapid["public_key"])
put_secret("VAPID_PRIVATE_KEY", vapid["private_key"])
put_secret("VAPID_SUBJECT", "https://teacher101.teacher-operations-cloudflare.workers.dev")
print("Cloudflare secrets 全部設定完成；未顯示或寫入明碼密碼。")
