// server.js  (package.json に "type": "module" がある前提)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import basicAuth from "express-basic-auth";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import { WebClient } from "@slack/web-api";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN; // xoxb-***
const TEAM_ID_ENV = process.env.TEAM_ID || "";       // 任意
const AUDIT_LOG_FILE = process.env.AUDIT_LOG_FILE || "";
// 例: TRUST_PROXY=1（リバースプロキシ1段の背後で運用する場合）
const TRUST_PROXY = process.env.TRUST_PROXY || "";
// HTTPS を強制（TLS 終端プロキシの背後で使う。TRUST_PROXY と併用）
const FORCE_HTTPS = process.env.FORCE_HTTPS === "1";

// 利用者ごとの Basic 認証アカウント（監査ログで送信者を識別するため）
// BASIC_AUTH_USERS="alice:pass1,bob:pass2"。旧形式の BASIC_AUTH_USER / BASIC_AUTH_PASS も可
function loadAuthUsers() {
  const users = {};
  for (const pair of (process.env.BASIC_AUTH_USERS || "").split(",")) {
    const i = pair.indexOf(":");
    if (i > 0 && i < pair.length - 1) users[pair.slice(0, i).trim()] = pair.slice(i + 1);
  }
  if (process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASS) {
    users[process.env.BASIC_AUTH_USER] = process.env.BASIC_AUTH_PASS;
  }
  return users;
}
const AUTH_USERS = loadAuthUsers();
const HAS_AUTH = Object.keys(AUTH_USERS).length > 0;
// 認証なしで外部公開しないよう、資格情報が無い場合は localhost のみで待受
const HOST = process.env.HOST || (HAS_AUTH ? "0.0.0.0" : "127.0.0.1");

const MAX_RECIPIENTS = 200;
const MAX_TEXT_LEN = 40000; // Slack の text 上限
const SLACK_ID_RE = /^[A-Z][A-Z0-9]{2,30}$/;

const bot = SLACK_BOT_TOKEN ? new WebClient(SLACK_BOT_TOKEN) : null;

app.disable("x-powered-by");
if (TRUST_PROXY) app.set("trust proxy", /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);

// ------------- HTTPS 強制 -------------
if (FORCE_HTTPS) {
  app.use((req, res, next) => {
    if (req.secure) {
      res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
      return next();
    }
    if (req.method === "GET" || req.method === "HEAD") {
      return res.redirect(308, `https://${req.get("host")}${req.originalUrl}`);
    }
    res.status(403).json({ ok:false, error:"https_required" });
  });
}

// ------------- セキュリティヘッダ -------------
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
  next();
});

// ------------- 認証（Basic） -------------
// 認証失敗の総当たり対策：401 のみカウント（API の入力エラー等は数えない）
const authFailureLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => res.statusCode !== 401,
  standardHeaders: "draft-7", legacyHeaders: false,
  message: { ok:false, error:"too_many_auth_failures" },
});
if (HAS_AUTH) {
  app.use(authFailureLimiter);
  app.use(basicAuth({ users: AUTH_USERS, challenge: true, realm: "Send" }));
} else {
  console.warn("[WARN] BASIC_AUTH_USERS 未設定のため 127.0.0.1 のみで待受します");
}

// ------------- CSRF 対策 -------------
// カスタムヘッダ必須（クロスオリジンからはプリフライトで拒否される）＋ Origin 検証
app.use("/api", (req, res, next) => {
  if (req.get("x-requested-with") !== "send") {
    return res.status(403).json({ ok:false, error:"csrf_check_failed" });
  }
  // プロキシ背後では protocol が変わるため host のみで比較
  const origin = req.get("origin");
  let originHost = null;
  try { originHost = origin ? new URL(origin).host : null; } catch {}
  if (origin && originHost !== req.get("host")) {
    return res.status(403).json({ ok:false, error:"origin_not_allowed" });
  }
  next();
});

// ------------- レート制限 -------------
// 認証済みならアカウント単位、未認証（localhost 運用）なら IP 単位
const limiterKey = (req) => req.auth?.user ? `user:${req.auth.user}` : `ip:${req.ip}`;
const makeLimiter = (windowMs, limit) => rateLimit({
  windowMs, limit, keyGenerator: limiterKey,
  standardHeaders: "draft-7", legacyHeaders: false,
  message: { ok:false, error:"rate_limited" },
});
app.use("/api", makeLimiter(60 * 1000, 120));
const sendLimiter = makeLimiter(60 * 1000, 5);
const verifyLimiter = makeLimiter(60 * 1000, 10);

app.use(express.json({ limit: "200kb" }));

// ------------- 監査ログ -------------
// トークンや本文全体は残さず、誰が・どこへ・何を送ったかの要点のみ記録
function audit(req, event, detail) {
  const line = JSON.stringify({
    at: new Date().toISOString(), event,
    actor: req.auth?.user || "(anonymous)", ip: req.ip,
    ...detail,
  });
  console.log(`[AUDIT] ${line}`);
  if (AUDIT_LOG_FILE) {
    fs.appendFile(AUDIT_LOG_FILE, line + "\n", { mode: 0o600 }, (e) => { if (e) console.error("audit log write failed:", e.message); });
  }
}
const messageDigest = (text) => crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);

// 直近の送信履歴（トークンは保持しない）
// id -> { actor, mode, userId?, results:[{channel,ts}] }
const broadcasts = new Map();
const MAX_BROADCAST_HISTORY = 20;

// util
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pickTeamIdFallback = (teamIdFromClient) => teamIdFromClient || TEAM_ID_ENV || undefined;
const safeJson = (res, payload, status = 200) => res.status(status).json(payload);
const isSlackId = (v) => typeof v === "string" && SLACK_ID_RE.test(v);
const isIdList = (v) => Array.isArray(v) && v.length <= MAX_RECIPIENTS && v.every(isSlackId);
// ユーザートークンはヘッダのみで受け取る（URL に載せるとログや履歴に残るため）
const userTokenFromHeader = (req) => req.get("x-user-token") || "";

// ワークスペースのユーザー名簿（users.list）を短時間キャッシュ
const DIRECTORY_TTL_MS = 5 * 60 * 1000;
let directoryCache = null; // { at, users:[slackUser] }
let directoryLoading = null;
async function fetchDirectory(client) {
  const users = [];
  let cursor;
  do {
    const r = await client.users.list({ limit: 1000, cursor });
    (r.members || []).forEach(u => users.push(u));
    cursor = r.response_metadata?.next_cursor;
  } while (cursor);
  return users;
}
async function getBotDirectory() {
  if (directoryCache && Date.now() - directoryCache.at < DIRECTORY_TTL_MS) return directoryCache.users;
  directoryLoading ??= fetchDirectory(bot)
    .then(users => { directoryCache = { at: Date.now(), users }; return users; })
    .finally(() => { directoryLoading = null; });
  return directoryLoading;
}
const displayName = (u) =>
  u.profile?.real_name?.trim() || u.profile?.display_name?.trim() || u.name || u.id;

// ------------- API: チャンネル一覧（bot視点） -------------
app.get("/api/channels", async (req, res, next) => {
  try {
    if (!bot) return safeJson(res, [], 200);
    const out = [];
    let cursor;
    do {
      const r = await bot.conversations.list({
        limit: 1000, cursor,
        types: "public_channel,private_channel"
      });
      (r.channels || []).forEach(c => out.push({ id:c.id, name:c.name, is_private:!!c.is_private }));
      cursor = r.response_metadata?.next_cursor;
    } while (cursor);
    safeJson(res, out);
  } catch (e) { next(e); }
});

// ------------- API: ユーザー一覧（DM用） -------------
app.get("/api/users", async (req, res, next) => {
  try {
    if (!bot) return safeJson(res, [], 200);
    const users = (await getBotDirectory())
      .filter(u => !u.deleted && !u.is_bot)
      .map(u => ({ id:u.id, name: u.profile?.real_name || u.name || u.id }));
    safeJson(res, users);
  } catch (e) { next(e); }
});

// ------------- API: 指定CHのメンバー一覧（bot / userToken） -------------
app.get("/api/channel-members", async (req, res, next) => {
  try {
    const { channel } = req.query;
    const mode = (req.query.mode || "bot").toLowerCase();
    const teamId = pickTeamIdFallback(req.query.teamId);
    const userToken = userTokenFromHeader(req);

    const client = (mode === "user" && userToken) ? new WebClient(userToken) : bot;
    if (!isSlackId(channel) || !client) return safeJson(res, [], 200);

    const ids = [];
    let cursor;
    do {
      const r = await client.conversations.members({
        channel, limit: 1000, cursor, ...(teamId ? { team_id: teamId } : {})
      });
      (r.members || []).forEach(id => ids.push(id));
      cursor = r.response_metadata?.next_cursor;
    } while (cursor);

    // 名前解決：メンバーごとの users.info ではなく名簿を一括取得して引く
    const directory = bot ? await getBotDirectory() : await fetchDirectory(client);
    const names = new Map(directory.map(u => [u.id, displayName(u)]));
    safeJson(res, ids.map(uid => ({ id: uid, name: names.get(uid) || uid })));
  } catch (e) { next(e); }
});

// ------------- API: 個人トークン検証 -------------
app.post("/api/personal/verify", verifyLimiter, async (req, res, next) => {
  try {
    const userToken = req.body?.userToken;
    const teamId = pickTeamIdFallback(req.body?.teamId);
    if (!userToken) return safeJson(res, { ok:false, error:"token_required" }, 400);

    const userClient = new WebClient(userToken);
    const auth = await userClient.auth.test();
    const memberChannels = [];
    let cursor;
    do {
      const r = await userClient.conversations.list({
        limit:1000, cursor, types:"public_channel,private_channel",
        ...(teamId ? { team_id: teamId } : {})
      });
      (r.channels || []).forEach(c => { if (c.is_member) memberChannels.push({ id:c.id, name:c.name, is_private:!!c.is_private }); });
      cursor = r.response_metadata?.next_cursor;
    } while (cursor);

    const publicChannels = [];
    cursor = undefined;
    do {
      const r = await userClient.conversations.list({
        limit:1000, cursor, types:"public_channel",
        ...(teamId ? { team_id: teamId } : {})
      });
      (r.channels || []).forEach(c => publicChannels.push({ id:c.id, name:c.name, is_private:!!c.is_private }));
      cursor = r.response_metadata?.next_cursor;
    } while (cursor);

    safeJson(res, {
      ok:true,
      user: { id: auth.user_id, name: auth.user },
      memberChannels, publicChannels
    });
  } catch (e) { next(e); }
});

// ------------- ヘルパー：本文にメンションを組み立てる -------------
// plan = { mode:"channel"|"user", users?:[{id,name}] }
function buildTextWithPlan(text, plan) {
  if (!plan || !plan.mode) return text;
  if (plan.mode === "channel") return `<!channel> \n ${text}`;
  if (plan.mode === "user") {
    const ids = (plan.users || []).map(u => u.id).filter(Boolean);
    if (ids.length) return `${ids.map(id => `<@${id}>`).join(" ")} \n ${text}`;
  }
  return text;
}

// ------------- API: 送信 -------------
app.post("/api/broadcast", sendLimiter, async (req, res, next) => {
  try {
    const {
      message, summary,
      channelIds = [], userIds = [],
      autoJoinPublic = false,
      perChannelMentions = {},   // { chId: { mode:"channel"|"user", users?:[] } }
      mode = "bot",
      userToken, teamId
    } = req.body || {};

    if (typeof message !== "string" || !message || message.length > MAX_TEXT_LEN
        || (summary != null && (typeof summary !== "string" || summary.length > MAX_TEXT_LEN))
        || !isIdList(channelIds) || !isIdList(userIds)
        || (!channelIds.length && !userIds.length)
        || channelIds.length + userIds.length > MAX_RECIPIENTS
        || typeof perChannelMentions !== "object" || perChannelMentions === null) {
      return safeJson(res, { ok:false, error:"invalid_params" }, 400);
    }
    // メンション対象IDの検証（"<@...>" への注入防止）
    for (const plan of Object.values(perChannelMentions)) {
      if (plan?.mode === "user" && !(plan.users || []).every(u => isSlackId(u?.id))) {
        return safeJson(res, { ok:false, error:"invalid_params" }, 400);
      }
    }

    if (mode === "user" && !userToken) return safeJson(res, { ok:false, error:"token_required" }, 400);
    const client = mode === "user" ? new WebClient(userToken) : bot;
    if (!client) return safeJson(res, { ok:false, error:"no_token" }, 400);

    // user モードでは送信者を記録し、取り消し時に同一ユーザーか照合する
    let senderUserId;
    if (client !== bot) {
      const auth = await client.auth.test();
      senderUserId = auth.user_id;
    }

    const effectiveTeam = pickTeamIdFallback(teamId);
    const results = [];

    // CH メッセージ
    for (const ch of channelIds) {
      const plan = Object.hasOwn(perChannelMentions, ch) ? perChannelMentions[ch] : { mode:"channel" };
      const text = buildTextWithPlan(message, plan);

      if (autoJoinPublic && client === bot && ch.startsWith("C")) {
        try { await client.conversations.join({ channel: ch }); } catch {}
      }

      try {
        const r = await client.chat.postMessage({
          channel: ch, text, ...(effectiveTeam ? { team: effectiveTeam } : {})
        });
        results.push({ ok: r.ok, channel: ch, ts: r.ts });

        if (summary && r.ok) {
          await client.chat.postMessage({
            channel: r.channel, thread_ts: r.ts, text: "```\n"+summary+"\n```"
          });
        }
      } catch (e) {
        results.push({ ok:false, channel: ch, error: e?.data?.error || e.message });
      }
      await sleep(200);
    }

    // DM
    for (const uid of userIds) {
      try {
        const im = await client.conversations.open({ users: uid, ...(effectiveTeam ? { team_id: effectiveTeam } : {}) });
        const r = await client.chat.postMessage({ channel: im.channel.id, text: message });
        results.push({ ok: r.ok, channel: im.channel.id, ts: r.ts, dm_to: uid });
        if (summary && r.ok) {
          await client.chat.postMessage({ channel: r.channel, thread_ts: r.ts, text: "```\n"+summary+"\n```" });
        }
      } catch (e) {
        results.push({ ok:false, dm_to: uid, error: e?.data?.error || e.message });
      }
      await sleep(200);
    }

    const broadcastId = `b${crypto.randomUUID()}`;
    broadcasts.set(broadcastId, {
      actor: req.auth?.user,
      mode: client === bot ? "bot" : "user",
      userId: senderUserId,
      results: results.filter(r => r.ok && r.channel && r.ts).map(r => ({ channel:r.channel, ts:r.ts }))
    });
    while (broadcasts.size > MAX_BROADCAST_HISTORY) broadcasts.delete(broadcasts.keys().next().value);

    audit(req, "broadcast", {
      broadcastId, mode: client === bot ? "bot" : "user", slackUserId: senderUserId,
      channels: channelIds, dms: userIds,
      messageSha256: messageDigest(message), messageLength: message.length,
      okCount: results.filter(r => r.ok).length, failCount: results.filter(r => !r.ok).length,
    });

    safeJson(res, { ok: results.every(r => r.ok), broadcast_id: broadcastId, results });
  } catch (e) { next(e); }
});

// ------------- API: 取り消し -------------
app.post("/api/broadcast/undo-last", sendLimiter, async (req, res, next) => {
  try {
    const broadcastId = req.body?.broadcastId;
    const target = typeof broadcastId === "string" ? broadcasts.get(broadcastId) : undefined;
    if (!target?.results?.length)
      return res.status(400).json({ ok: false, error: "no_last_broadcast" });
    if (target.actor !== req.auth?.user)
      return res.status(403).json({ ok:false, error:"not_owner" });

    // 送信時と同じ主体のトークンでのみ取り消し可能
    let client;
    if (target.mode === "user") {
      const userToken = userTokenFromHeader(req);
      if (!userToken) return res.status(401).json({ ok:false, error:"token_required" });
      client = new WebClient(userToken);
      const auth = await client.auth.test();
      if (auth.user_id !== target.userId) return res.status(403).json({ ok:false, error:"not_owner" });
    } else {
      if (!bot) return res.status(400).json({ ok:false, error:"no_token" });
      client = bot;
    }
    const results = [];

    for (const it of target.results) {
      try {
        let allMessages = [];
        let cursor;

        // 🔁 ページネーション付きで replies を全取得
        do {
          const r = await client.conversations.replies({
            channel: it.channel,
            ts: it.ts,
            cursor,
            limit: 200, // 最大値
          });
          allMessages = allMessages.concat(r.messages || []);
          cursor = r.response_metadata?.next_cursor;
        } while (cursor);

        // 親含めて全削除（新しい順で確実に消す）
        for (const msg of [...allMessages].reverse()) {
          try {
            await client.chat.delete({
              channel: it.channel,
              ts: msg.ts,
            });
            await sleep(150);
          } catch (e) {
            console.warn("削除失敗:", e.data?.error || e.message);
          }
        }

        results.push({ ok: true, channel: it.channel, ts: it.ts });
      } catch (e) {
        results.push({
          ok: false,
          channel: it.channel,
          ts: it.ts,
          error: e?.data?.error || e.message,
        });
      }
      await sleep(300);
    }

    broadcasts.delete(broadcastId);
    audit(req, "undo", {
      broadcastId, mode: target.mode, slackUserId: target.userId,
      okCount: results.filter(r => r.ok).length, failCount: results.filter(r => !r.ok).length,
    });
    res.json({ ok: results.every(r => r.ok), results });
  } catch (e) {
    next(e);
  }
});

// ------------- 静的配信 -------------
app.use(express.static(path.join(process.cwd(), "public")));
app.get("*", (req, res) => res.sendFile(path.join(process.cwd(), "public", "index.html")));

// ------------- エラーハンドラ（スタックトレースを返さない） -------------
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  const status = err?.data?.error ? 502 : (err?.status || 500);
  res.status(status).json({ ok:false, error: err?.data?.error || "internal_error" });
});

app.listen(PORT, HOST, () => console.log(`Server running: http://${HOST}:${PORT}`));
