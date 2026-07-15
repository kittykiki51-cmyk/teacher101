from __future__ import annotations

import base64
import secrets

from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid


def base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


vapid = Vapid()
vapid.generate_keys()
private_key = vapid.private_key.private_bytes(
    encoding=serialization.Encoding.DER,
    format=serialization.PrivateFormat.PKCS8,
    encryption_algorithm=serialization.NoEncryption(),
)
public_key = vapid.public_key.public_bytes(
    encoding=serialization.Encoding.X962,
    format=serialization.PublicFormat.UncompressedPoint,
)

print(f"SECRET_KEY={secrets.token_urlsafe(48)}")
print(f"VAPID_PRIVATE_KEY={base64url(private_key)}")
print(f"VAPID_PUBLIC_KEY={base64url(public_key)}")
