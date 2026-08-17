#!/usr/bin/env python3
"""Prompt for an app password and emit a PBKDF2-SHA256 secret value."""

from __future__ import annotations

import base64
import getpass
import hashlib
import os


def base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


password = getpass.getpass("請輸入網站密碼：")
confirmation = getpass.getpass("請再輸入一次：")
if not password or password != confirmation:
    raise SystemExit("兩次密碼不一致，未產生任何內容。")

iterations = 310_000
salt = os.urandom(16)
digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations, dklen=32)
print(f"pbkdf2_sha256${iterations}${base64url(salt)}${base64url(digest)}")
