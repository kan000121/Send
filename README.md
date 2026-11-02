# Send — Slack 一斉送信ツール

複数チャンネル / DM へのメッセージを GUI から一括送信・取り消しできる、社内向け Slack ブロードキャストツール。

## 主な機能

- **複数チャンネル/DM への一斉送信**：チャンネル・ユーザーを選択して同一メッセージを送信
- **メンション制御**：チャンネルごとに `@channel` / 個別ユーザーメンションを切替
- **スレッド要約添付**：本文と一緒にコードブロック形式の要約をスレッドへ自動投稿
- **直前送信の取り消し**：`undo-last` で親メッセージ＋スレッド全体を一括削除
- **2種類の認証モード**：Bot Token / User Token を切替可能
- **チャンネルメンバー一覧取得**：送信先メンバーを名前解決付きで表示

## 技術スタック

- **Backend**: Node.js 20 / Express
- **Slack 連携**: `@slack/web-api`
- **Frontend**: HTML + Vanilla JS（単一の `public/index.html`）

## セットアップ

```bash
git clone https://github.com/kan000121/Send.git
cd Send
npm install
# .env を作成し、SLACK_BOT_TOKEN を設定
npm start
```

## 環境変数

| 変数名 | 説明 |
|---|---|
| `SLACK_BOT_TOKEN` | Slack Bot Token（`xoxb-...`） |
| `TEAM_ID` | (任意) 既定の Slack ワークスペースID |
| `PORT` | サーバ待受ポート（デフォルト 3000） |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` | Basic 認証の資格情報。未設定時は `127.0.0.1` のみで待受 |
| `HOST` | (任意) 待受アドレスを明示指定 |

## セキュリティ

- 全ページ・API は Basic 認証で保護（外部公開時は必ず HTTPS の背後で運用すること）
- API は `X-Requested-With: send` ヘッダ必須＋ Origin 検証で CSRF を防止
- User Token はサーバに保存せず、`x-user-token` ヘッダ（またはPOSTボディ）でのみ受け取る
- 取り消しは `broadcastId` 指定、User Token 送信分は同一ユーザーのトークンでのみ実行可能

## API エンドポイント

| Method | Path | 説明 |
|---|---|---|
| GET | `/api/channels` | Bot が参加するチャンネル一覧 |
| GET | `/api/users` | ワークスペースのユーザー一覧 |
| GET | `/api/channel-members` | 指定CHのメンバー一覧（名前解決付き） |
| POST | `/api/personal/verify` | User Token の検証 |
| POST | `/api/broadcast` | 一斉送信を実行 |
| POST | `/api/broadcast/undo-last` | 指定 `broadcastId` のブロードキャストを取り消し |

## 必要な Slack スコープ

- Bot Token: `chat:write`, `chat:write.public`, `channels:read`, `groups:read`, `users:read`, `im:write`, `conversations.connect:read`
- User Token（任意）: `channels:read`, `groups:read`, `chat:write`

## ライセンス

MIT License — 個人プロジェクト
