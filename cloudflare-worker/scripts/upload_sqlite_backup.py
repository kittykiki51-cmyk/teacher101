#!/usr/bin/env python3
"""Upload a verified Railway SQLite backup through the guarded migration API."""

from __future__ import annotations

import argparse
import getpass
import hashlib
import http.cookiejar
import json
import os
import sqlite3
import urllib.error
import urllib.request
import urllib.parse
from pathlib import Path


def request_json(
    opener: urllib.request.OpenerDirector,
    url: str,
    method: str = "GET",
    body: object | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, dict]:
    payload = None if body is None else json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request_headers = {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
        **(headers or {}),
    }
    if payload is not None:
        request_headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=payload, headers=request_headers, method=method)
    try:
        with opener.open(request, timeout=60) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(raw)
        except json.JSONDecodeError:
            detail = {"error": raw or str(error)}
        return error.code, detail


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("base_url")
    parser.add_argument("sqlite_backup", type=Path)
    parser.add_argument("--password-env", default="TEACHER101_MIGRATION_PASSWORD")
    parser.add_argument("--migration-token-env", default="")
    args = parser.parse_args()
    base_url = args.base_url.rstrip("/")
    if not args.sqlite_backup.is_file():
        raise SystemExit(f"找不到 SQLite 備份：{args.sqlite_backup}")

    migration_token = os.environ.get(args.migration_token_env, "") if args.migration_token_env else ""
    if migration_token:
        opener = urllib.request.build_opener()
        migration_headers = {"X-Migration-Token": migration_token}
    else:
        password = os.environ.get(args.password_env) or getpass.getpass("請輸入網站密碼：")
        parsed_url = urllib.parse.urlparse(base_url)
        local_http = parsed_url.scheme == "http" and parsed_url.hostname in {"127.0.0.1", "localhost"}
        secure_protocols = ("https", "wss", "http") if local_http else ("https", "wss")
        cookie_jar = http.cookiejar.CookieJar(
            policy=http.cookiejar.DefaultCookiePolicy(secure_protocols=secure_protocols)
        )
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookie_jar))
        status, login = request_json(opener, f"{base_url}/api/login", "POST", {"password": password})
        password = ""
        if status != 200:
            raise SystemExit(f"登入失敗（HTTP {status}）：{login.get('error', '未知錯誤')}")
        status, loaded = request_json(opener, f"{base_url}/api/workspace")
        if status != 200:
            raise SystemExit(f"無法取得 CSRF token（HTTP {status}）")
        migration_headers = {"X-CSRF-Token": loaded["csrf_token"]}

    connection = sqlite3.connect(f"file:{args.sqlite_backup}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
    if integrity != "ok":
        raise SystemExit(f"來源資料庫完整性檢查失敗：{integrity}")
    workspace_row = connection.execute(
        "SELECT revision, payload, updated_at FROM workspace WHERE id = 1"
    ).fetchone()
    backup_rows = connection.execute(
        "SELECT id, revision, payload, created_at FROM workspace_backups ORDER BY id"
    ).fetchall()
    sent_rows = connection.execute(
        "SELECT notification_key, sent_at FROM sent_notifications ORDER BY notification_key"
    ).fetchall()
    source_payload_hash = hashlib.sha256(workspace_row["payload"].encode("utf-8")).hexdigest()

    status, result = request_json(
        opener,
        f"{base_url}/api/migration/workspace",
        "POST",
        {
            "workspace": json.loads(workspace_row["payload"]),
            "revision": workspace_row["revision"],
            "updated_at": workspace_row["updated_at"],
        },
        migration_headers,
    )
    if status != 200:
        raise SystemExit(f"目前工作資料匯入失敗（HTTP {status}）：{result.get('error', result)}")

    uploaded_backups = 0
    for row in backup_rows:
        status, result = request_json(
            opener,
            f"{base_url}/api/migration/backup",
            "POST",
            {
                "id": row["id"],
                "revision": row["revision"],
                "workspace": json.loads(row["payload"]),
                "created_at": row["created_at"],
            },
            migration_headers,
        )
        if status != 200:
            raise SystemExit(f"備份 id={row['id']} 匯入失敗（HTTP {status}）：{result.get('error', '未知錯誤')}")
        uploaded_backups += 1

    uploaded_sent = 0
    for row in sent_rows:
        status, result = request_json(
            opener,
            f"{base_url}/api/migration/sent-notification",
            "POST",
            {"notification_key": row["notification_key"], "sent_at": row["sent_at"]},
            migration_headers,
        )
        if status != 200:
            raise SystemExit(f"通知紀錄匯入失敗（HTTP {status}）：{result.get('error', '未知錯誤')}")
        uploaded_sent += 1
    connection.close()

    status, final_status = request_json(opener, f"{base_url}/api/migration/status", headers=migration_headers)
    if status != 200:
        raise SystemExit(f"遷移後驗證失敗（HTTP {status}）")
    if migration_token:
        canonical_source_hash = hashlib.sha256(
            json.dumps(json.loads(workspace_row["payload"]), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        target_payload_hash = final_status["workspace"]["payload_sha256"]
    else:
        status, verified = request_json(opener, f"{base_url}/api/workspace")
        if status != 200:
            raise SystemExit(f"遷移後工作資料讀取失敗（HTTP {status}）")
        target_payload = json.dumps(verified["workspace"], ensure_ascii=False, separators=(",", ":"))
        target_payload_hash = hashlib.sha256(target_payload.encode("utf-8")).hexdigest()
        canonical_source = json.dumps(json.loads(workspace_row["payload"]), ensure_ascii=False, separators=(",", ":"))
        canonical_source_hash = hashlib.sha256(canonical_source.encode("utf-8")).hexdigest()
    if target_payload_hash != canonical_source_hash:
        raise SystemExit("遷移後工作資料雜湊不一致")
    if final_status["workspace"]["revision"] != workspace_row["revision"]:
        raise SystemExit("遷移後 revision 不一致")
    if final_status["backups"] != len(backup_rows) or final_status["sent_notifications"] != len(sent_rows):
        raise SystemExit("遷移後資料筆數不一致")

    print(
        "Migration verified: "
        f"revision={workspace_row['revision']}, backups={uploaded_backups}, "
        f"sent_notifications={uploaded_sent}, canonical_payload_sha256={canonical_source_hash}, "
        f"source_storage_sha256={source_payload_hash}"
    )


if __name__ == "__main__":
    main()
