# Send — Slack 一斉送信ツール

複数チャンネル / DM へのメッセージを GUI から一括送信・取り消しできる、社内向け Slack ブロードキャストツール。

## 主な機能

- **複数チャンネル/DM への一斉送信**：チャンネル・ユーザーを選択して同一メッセージを送信
- **メンション制御**：チャンネルごとに `@channel` / 個別ユーザーメンションを切替
- **スレッド要約添付**：本文と一緒にコードブロック形式の要約をスレッドへ自動投稿
- **直前送信の取り消し**：`undo-last` で親メッセージと自分のスレッド返信を一括削除
- **Slack でログイン**：OAuth でログインするだけで個人として送信（トークンの貼り付け不要）。Bot として送信も選択可能
- **チャンネルメンバー一覧取得**：送信先メンバーを名前解決付きで表示
- **使い方ガイド**：画面右上の「使い方」からスライド形式のヘルプ（ログイン方法など）を表示

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
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | Slack でログイン（推奨）。Slack アプリの Basic Information にある値。両方設定すると有効 |
| `ALLOWED_TEAM_IDS` | (推奨) ログインを許可するワークスペースの team_id（`T...`、Enterprise Grid は `E...` も可。カンマ区切り）。未設定だとどのワークスペースでもログインできる |
| `PUBLIC_URL` | (任意) 公開 URL（例 `https://send-atfh.onrender.com`）。Slack ログインのリダイレクト先に使う。Render では自動取得されるので不要 |
| `SESSION_SECRET` | (任意) ログイン Cookie の暗号鍵。未設定なら `SLACK_CLIENT_SECRET` から導出 |
| `SLACK_BOT_TOKEN` | (任意) 既定の Slack Bot Token（`xoxb-...`）。未設定でも画面から入力可能 |
| `TEAM_ID` | (任意) 既定の Slack ワークスペースID |
| `PORT` | サーバ待受ポート（デフォルト 3000。Render などは自動で設定されるので指定不要） |
| `BASIC_AUTH_USERS` | (任意) 利用者ごとの Basic 認証。Slack でログインを使う場合は不要。（`alice:pass1,bob:pass2`）。パスワードは `npm run hash-password` で作ったハッシュ（`alice:scrypt$...`）で指定するのを推奨。ログイン設定（Slack ログインか Basic 認証）が無い場合は `127.0.0.1` のみで待受。旧形式の `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` も可 |
| `HOST` | (任意) 待受アドレスを明示指定 |
| `TRUST_PROXY` | (任意) リバースプロキシの背後で運用する場合に設定（例: `1`） |
| `FORCE_HTTPS` | (任意) `1` で HTTP→HTTPS リダイレクトと HSTS を有効化（`TRUST_PROXY` と併用） |
| `AUDIT_LOG_FILE` | (任意) 監査ログ（JSON Lines）の追記先。未設定時は標準出力のみ |

## Slack でログインの設定

1. `https://api.slack.com/apps` で送信用アプリを開く
2. **OAuth & Permissions → Redirect URLs** に `https://（公開URL）/auth/slack/callback` を追加して Save URLs
3. 同じ画面の **User Token Scopes** に `chat:write`, `channels:read`, `groups:read`, `users:read`, `im:write` があることを確認
4. **Basic Information → App Credentials** の Client ID / Client Secret を `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` に設定
5. 初回ログイン後、Render の Logs に出る `[AUDIT] {"event":"login", ... "teamIds":["T..."]}` の team_id を `ALLOWED_TEAM_IDS` に設定

ログインすると、ユーザートークンは AES-256-GCM で暗号化した HttpOnly Cookie（7日間有効）に保存され、画面の JavaScript からは読めない。サーバー側にはセッションを保存しないため、再起動後もログインは続く。

## パスワードのハッシュ化（Basic 認証を使う場合）

```bash
npm run hash-password   # パスワードを2回入力（画面には表示されない）
# → scrypt$16384$8$1$... が出力される
```

出力を `BASIC_AUTH_USERS=kanta:scrypt$16384$8$1$...` のように設定する（複数人はカンマ区切り。平文とハッシュの混在も可）。シェルで `export` する場合は `$` が展開されないようシングルクォートで囲むこと。`.env` と Render の Environment はそのままでよい。

## Render へのデプロイ

- Build Command: `npm install` / Start Command: `npm start`
- `PORT` は Render が自動で渡す（既定 10000）ため設定不要
- Settings → **Health Check Path** は `/healthz`（ログイン不要で `ok` を返す）
- Environment に以下を設定する
  - `SLACK_CLIENT_ID`、`SLACK_CLIENT_SECRET`、`ALLOWED_TEAM_IDS`（Slack でログイン。上の「Slack でログインの設定」を参照）
  - Slack ログインを使わない場合は `BASIC_AUTH_USERS`（ハッシュ化して設定）。どちらも無いと起動時にエラーで停止します
  - `TRUST_PROXY=1`、`FORCE_HTTPS=1`
  - 必要に応じて `SLACK_BOT_TOKEN`、`TEAM_ID`
- `AUDIT_LOG_FILE` は指定しない（ディスクは再デプロイで消えるため。監査ログは標準出力経由で Render の Logs に残る）
- 無料プランはアクセスが無いとスリープし、再起動すると「直前の送信の取り消し」履歴が消える

## セキュリティ

- Slack でログイン（OAuth）を設定すると、`/api/session` と `/healthz` 以外の API はログイン必須。`ALLOWED_TEAM_IDS` で自社ワークスペース以外を拒否
- ログインの CSRF 対策として OAuth の `state` を HttpOnly Cookie と照合。ユーザートークンは暗号化 Cookie（HttpOnly・SameSite=Lax・HTTPS 時 Secure）に入れ、画面には渡さない
- Basic 認証を使う場合、パスワードは scrypt ハッシュで設定でき、環境変数を見られても元のパスワードは分からない
- 外部公開時は TLS 終端プロキシの背後に置き、`TRUST_PROXY=1` `FORCE_HTTPS=1` を設定すること
- 認証失敗は IP あたり 15 分 20 回まで。API は 1 分 120 回、送信・取り消しは 1 分 5 回、トークン検証は 1 分 10 回まで（アカウント単位）
- API は `X-Requested-With: send` ヘッダ必須＋ Origin 検証で CSRF を防止
- 画面から入力した Bot Token はサーバに保存せず、`x-bot-token` ヘッダでのみ受け取る。Slack ログインを使わない場合の User Token も同様（`x-user-token` ヘッダ。POST ボディも可）。Slack ログイン時はヘッダ・ボディの User Token を無視する
- 取り消しは送信時に記録した自分の投稿（親メッセージ＋案件概要の返信）を直接削除する。スレッド内の他の人の返信は削除しない。失敗した分は再度取り消し可能
- 取り消しは `broadcastId` 指定。送信したアカウント（Slack ログインのユーザー、または Basic 認証のアカウント）本人のみ実行可能で、さらに送信時と同じ Slack ユーザー／Bot のトークンが必要
- ログイン設定が無いまま localhost 以外の `HOST` を指定すると起動を拒否
- サーバーログにはトークンを出力しない（Slack SDK のエラーはコードと伏字化したメッセージのみ記録）
- CSP でインラインスクリプトを禁止（画面のスクリプトは `public/app.js`）
- 送信・取り消しは監査ログに記録（実行者・宛先・本文の SHA-256 先頭16桁と文字数。トークンと本文そのものは残さない）

## API エンドポイント

| Method | Path | 説明 |
|---|---|---|
| GET | `/auth/slack/login` | Slack でログイン開始（Slack の認可画面へリダイレクト） |
| GET | `/auth/slack/callback` | Slack からの戻り先。ログイン Cookie を発行 |
| GET | `/api/session` | ログイン状態 |
| POST | `/api/session/logout` | ログアウト |
| GET | `/healthz` | ヘルスチェック（ログイン不要） |
| GET | `/api/channels` | Bot が参加するチャンネル一覧 |
| GET | `/api/users` | ワークスペースのユーザー一覧 |
| GET | `/api/channel-members` | 指定CHのメンバー一覧（名前解決付き） |
| POST | `/api/bot/verify` | Bot Token の検証（`x-bot-token` 未指定時はサーバー設定のトークン） |
| POST | `/api/personal/verify` | User Token の検証 |
| POST | `/api/broadcast` | 一斉送信を実行 |
| POST | `/api/broadcast/undo-last` | 指定 `broadcastId` のブロードキャストを取り消し |

## 必要な Slack スコープ

- Bot Token: `chat:write`, `chat:write.public`, `channels:read`, `groups:read`, `users:read`, `im:write`, `conversations.connect:read`
- User Token（Slack でログインで取得）: `channels:read`, `groups:read`, `chat:write`, `users:read`（DM 宛先一覧。無い場合は Bot で取得）, `im:write`（DM 送信）

## ライセンス

MIT License — 個人プロジェクト
