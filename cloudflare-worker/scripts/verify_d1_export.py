#!/usr/bin/env python3
"""Compare a Cloudflare D1 SQL export with the verified Railway SQLite source."""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from pathlib import Path


def canonical_hash(payload: str) -> str:
    canonical = json.dumps(json.loads(payload), ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


parser = argparse.ArgumentParser()
parser.add_argument("source", type=Path)
parser.add_argument("d1_export", type=Path)
args = parser.parse_args()

source = sqlite3.connect(f"file:{args.source}?mode=ro", uri=True)
source.row_factory = sqlite3.Row
if source.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
    raise SystemExit("Railway 來源資料庫完整性檢查失敗")

target = sqlite3.connect(":memory:")
target.row_factory = sqlite3.Row
target.executescript(args.d1_export.read_text(encoding="utf-8"))
if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
    raise SystemExit("D1 匯出資料完整性檢查失敗")

source_workspace = source.execute("SELECT revision, payload FROM workspace WHERE id=1").fetchone()
target_workspace = target.execute("SELECT revision, payload FROM workspace WHERE id=1").fetchone()
source_hash = canonical_hash(source_workspace["payload"])
target_hash = canonical_hash(target_workspace["payload"])
if source_workspace["revision"] != target_workspace["revision"] or source_hash != target_hash:
    raise SystemExit("D1 工作資料與 Railway 來源不一致")

counts = {}
for table in ("workspace_backups", "push_subscriptions", "sent_notifications"):
    counts[table] = target.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
if counts != {"workspace_backups": 30, "push_subscriptions": 0, "sent_notifications": 50}:
    raise SystemExit(f"D1 資料筆數不正確：{counts}")

source.close()
target.close()
print(
    "D1 export verified: "
    f"revision={target_workspace['revision']}, canonical_payload_sha256={target_hash}, "
    f"backups={counts['workspace_backups']}, subscriptions={counts['push_subscriptions']}, "
    f"sent_notifications={counts['sent_notifications']}"
)
