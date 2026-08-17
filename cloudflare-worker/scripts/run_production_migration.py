#!/usr/bin/env python3
"""Run the production migration with an ephemeral Cloudflare secret."""

from __future__ import annotations

import os
import secrets
import subprocess
import sys
import time
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent.parent
WRANGLER = BASE_DIR / "node_modules" / ".bin" / "wrangler"
UPLOADER = BASE_DIR / "scripts" / "upload_sqlite_backup.py"
SOURCE = BASE_DIR.parent / "backups" / "railway_data_20260817_093459" / "verified_stream" / "teacher_operations.sqlite3"
URL = "https://teacher101.teacher-operations-cloudflare.workers.dev"


def run(command: list[str], *, input_value: str | None = None, environment: dict[str, str] | None = None) -> None:
    result = subprocess.run(
        command,
        cwd=BASE_DIR,
        env=environment,
        input=None if input_value is None else input_value + "\n",
        text=True,
        check=False,
    )
    if result.returncode:
        raise SystemExit(result.returncode)


token = secrets.token_urlsafe(48)
env = os.environ.copy()
env["WRANGLER_LOG_PATH"] = str(BASE_DIR / ".wrangler" / "wrangler-migration.log")
run([str(WRANGLER), "secret", "put", "MIGRATION_TOKEN"], input_value=token, environment=env)
run([str(WRANGLER), "deploy"], environment=env)
time.sleep(3)
upload_env = env.copy()
upload_env["TEACHER101_ONE_TIME_MIGRATION_TOKEN"] = token
run(
    [
        sys.executable,
        str(UPLOADER),
        URL,
        str(SOURCE),
        "--migration-token-env",
        "TEACHER101_ONE_TIME_MIGRATION_TOKEN",
    ],
    environment=upload_env,
)
token = ""
print("Production migration completed with an ephemeral token.")
