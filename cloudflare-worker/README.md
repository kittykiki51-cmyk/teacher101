# 老師專案管理 Cloudflare 版

這個目錄是現有 Railway Flask 網站的獨立 Cloudflare Workers + D1 遷移版。`public/` 保留目前 v36 的桌機、手機與 PWA 介面；Railway 原始檔與正式站不會在驗證完成前被替換。

正式網址：<https://teacher101.teacher-operations-cloudflare.workers.dev>

D1 資料庫：`teacher101`（APAC，ID `6d7fb804-a100-473a-95cc-96dbef71b967`）

## 架構

- Cloudflare Worker：登入、工作資料同步、推播訂閱與安全標頭
- D1：工作資料、30 份自動備份、推播訂閱、登入限速與通知紀錄
- Cron Trigger：每分鐘檢查工作與重要行程提醒
- Static Assets：沿用現有 `index.html`、`app.js`、`styles.css` 與 Service Worker

## 必要 secrets

- `APP_PASSWORD_HASH`：由 `scripts/hash_password.py` 產生的 PBKDF2-SHA256 值
- `SESSION_SECRET`：至少 32 字元的隨機值
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT`：有效的 `mailto:` 或 `https:` 聯絡 URI

所有 secrets 必須透過 `wrangler secret put` 設定，不應寫進 Git。

密碼雜湊固定使用 PBKDF2-SHA256 `100,000` 次，符合 Cloudflare Workers Web Crypto 的執行上限；登入限速仍會限制連續猜測。

## 資料遷移

`scripts/upload_sqlite_backup.py` 會先執行 SQLite 完整性檢查，再透過暫時開啟且受保護的遷移 API 逐筆匯入。長 JSON 不直接嵌入 SQL，以避開 D1 的 SQL statement 長度限制。`scripts/verify_d1_export.py` 會將 D1 匯出內容與 Railway 來源做 canonical JSON SHA-256 比對。

2026-08-17 已完成正式遷移並將 `MIGRATION_MODE` 關閉。舊 Railway 網域的瀏覽器推播訂閱沒有匯入，因為它無法代表新的 Cloudflare 網域；原始訂閱仍完整保留在 Railway 備份資料庫中。每台裝置第一次使用 Cloudflare 網址時，需重新按一次「啟用通知」。

Railway 正式站目前仍保留，待 Cloudflare 網址由使用者完成登入與通知實機確認後，再決定是否停止 Railway 服務。
