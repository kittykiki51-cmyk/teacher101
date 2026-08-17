#!/usr/bin/env python3
"""Convert the Railway PKCS8 VAPID private key to web-push raw scalar format."""

from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path

from cryptography.hazmat.primitives.serialization import load_der_private_key


def decode_base64url(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * ((4 - len(value) % 4) % 4))


def encode_base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


parser = argparse.ArgumentParser()
parser.add_argument("source", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
if args.output.exists():
    raise SystemExit(f"輸出檔已存在，為避免覆寫已停止：{args.output}")

saved = json.loads(args.source.read_text(encoding="utf-8"))
private_key = load_der_private_key(decode_base64url(saved["private_key"]), password=None)
private_scalar = private_key.private_numbers().private_value.to_bytes(32, "big")
converted = {
    "public_key": saved["public_key"],
    "private_key": encode_base64url(private_scalar),
}
args.output.parent.mkdir(parents=True, exist_ok=True)
with args.output.open("x", encoding="utf-8") as output:
    json.dump(converted, output)
print("VAPID key converted without displaying secret values")
