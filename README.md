# 老師專案管理雲端版

個人使用的密碼登入雲端版本。畫面與地端版一致，資料改由伺服器端 SQLite 保存，前端修改後會自動同步。

## 已完成

- 單一密碼登入，不需要帳號
- 安全 Cookie、CSRF 防護與登入嘗試限制
- 未登入時禁止讀取專案資料及應用程式檔案
- SQLite 雲端資料庫與版本衝突保護
- 每次修改前保存上一版，保留最近 30 份
- Chrome Web Push 訂閱、測試通知及工作到時提醒
- Service Worker 背景通知
- 手機與桌機自適應介面

## 本機啟動

1. 建立虛擬環境並安裝套件：

   ```bash
   python3 -m venv .venv-cloud
   .venv-cloud/bin/pip install -r requirements.txt
   ```

2. 產生雲端安全金鑰（選用，VAPID 推播金鑰也可由伺服器自動建立）：

   ```bash
   .venv-cloud/bin/python generate_cloud_secrets.py
   ```

3. 設定 `.env.example` 中列出的環境變數後啟動：

   ```bash
   COOKIE_SECURE=0 PORT=8080 .venv-cloud/bin/python server.py
   ```

正式部署必須設定 `COOKIE_SECURE=1`，並使用 HTTPS。登入密碼只設定在部署平台的 `APP_PASSWORD` 環境變數，不可寫入 JavaScript、HTML 或 Git。

`initial-data.js` 含真實營運資料，因此已排除在 Git 之外。全新部署會建立空白資料庫；登入後可由「更多設定」匯入地端版 JSON，資料只會寫入伺服器的私人 SQLite 資料庫。

## Chrome 通知

登入後前往「更多設定」，按「啟用這台裝置的通知」。每台電腦或手機都要各自允許一次。

有日期與時間的未完成工作，會在台北時區到達指定分鐘時由後端發送 Web Push。網頁可以關閉；但桌機若完全退出 Chrome，系統可能在 Chrome 再次啟動後才送達。

## 部署需求

- Python 3.10 以上
- HTTPS 網址
- 可持續運作的 Web Service
- 永久磁碟掛載至 `DATA_DIR`
- 單一 Gunicorn worker，避免重複執行通知排程

啟動命令已寫在 `Procfile`：

```text
gunicorn --workers 1 --threads 4 --bind 0.0.0.0:$PORT server:app
```
