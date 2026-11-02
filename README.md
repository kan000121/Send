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
- **Frontend**: HTML + Vanilla JS（`public/index.html` / `public/app.js`）

## セットアップ

```bash
git clone https://github.com/kan000121/Send.git
cd Send
npm install
# 必要に応じて .env を作成（Bot トークンは画面から入力することも可能）
npm start
```

## 環境変数

| 変数名 | 説明 |
|---|---|
| `SLACK_BOT_TOKEN` | (任意) 既定の Slack Bot Token（`xoxb-...`）。未設定でも画面から入力可能 |
| `TEAM_ID` | (任意) 既定の Slack ワークスペースID |
| `PORT` | サーバ待受ポート（デフォルト 3000） |
| `BASIC_AUTH_USERS` | 利用者ごとの Basic 認証（`alice:pass1,bob:pass2`）。未設定時は `127.0.0.1` のみで待受。旧形式の `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` も可 |
| `HOST` | (任意) 待受アドレスを明示指定 |
| `TRUST_PROXY` | (任意) リバースプロキシの背後で運用する場合に設定（例: `1`） |
| `FORCE_HTTPS` | (任意) `1` で HTTP→HTTPS リダイレクトと HSTS を有効化（`TRUST_PROXY` と併用） |
| `AUDIT_LOG_FILE` | (任意) 監査ログ（JSON Lines）の追記先。未設定時は標準出力のみ |

## セキュリティ

- 全ページ・API は Basic 認証で保護。外部公開時は TLS 終端プロキシの背後に置き、`TRUST_PROXY=1` `FORCE_HTTPS=1` を設定すること
- 認証失敗は IP あたり 15 分 20 回まで。API は 1 分 120 回、送信・取り消しは 1 分 5 回、トークン検証は 1 分 10 回まで（アカウント単位）
- API は `X-Requested-With: send` ヘッダ必須＋ Origin 検証で CSRF を防止
- User Token / 画面から入力した Bot Token はサーバに保存せず、`x-user-token` / `x-bot-token` ヘッダ（User Token は POST ボディも可）でのみ受け取る
- 取り消しは送信時に記録した自分の投稿（親メッセージ＋案件概要の返信）を直接削除する。スレッド内の他の人の返信は削除しない。失敗した分は再度取り消し可能
- 取り消しは `broadcastId` 指定。送信した Basic 認証アカウント本人のみ実行可能で、User Token 送信分は同一 Slack ユーザーのトークンが必要
- 認証なし（`BASIC_AUTH_USERS` 未設定）で localhost 以外の `HOST` を指定すると起動を拒否
- サーバーログにはトークンを出力しない（Slack SDK のエラーはコードと伏字化したメッセージのみ記録）
- CSP でインラインスクリプトを禁止（画面のスクリプトは `public/app.js`）
- 送信・取り消しは監査ログに記録（実行者・宛先・本文の SHA-256 先頭16桁と文字数。トークンと本文そのものは残さない）

## API エンドポイント

| Method | Path | 説明 |
|---|---|---|
| GET | `/api/channels` | Bot が参加するチャンネル一覧 |
| GET | `/api/users` | ワークスペースのユーザー一覧 |
| GET | `/api/channel-members` | 指定CHのメンバー一覧（名前解決付き） |
| POST | `/api/bot/verify` | Bot Token の検証（`x-bot-token` 未指定時はサーバー設定のトークン） |
| POST | `/api/personal/verify` | User Token の検証 |
| POST | `/api/broadcast` | 一斉送信を実行 |
| POST | `/api/broadcast/undo-last` | 指定 `broadcastId` のブロードキャストを取り消し |

## 必要な Slack スコープ

- Bot Token: `chat:write`, `chat:write.public`, `channels:read`, `groups:read`, `users:read`, `im:write`, `conversations.connect:read`
- User Token（任意）: `channels:read`, `groups:read`, `chat:write`, `users:read`（DM 宛先一覧。無い場合は Bot で取得）, `im:write`（DM 送信）

## ライセンス

MIT License — 個人プロジェクト
