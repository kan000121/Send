// server.js
import path from "node:path";
import fs from "node:fs";
import express from "express";
import dotenv from "dotenv";
import { WebClient } from "@slack/web-api";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN; // xoxb-***
const TEAM_ID_ENV = process.env.TEAM_ID || "";       // 任意（固定なら入れる）

if (!SLACK_BOT_TOKEN) {
  console.warn("[WARN] SLACK_BOT_TOKEN(.env) が未設定です。ボット送信/一覧は動きません。");
}

const bot = SLACK_BOT_TOKEN ? new WebClient(SLACK_BOT_TOKEN) : null;

// ------------------------------------
// middlewares
// ------------------------------------
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// 直近送信の保存（取り消し用）
let lastBroadcast = null; // { results:[{channel,ts,mode,token}], mode }

// ★ 追加: ユーザー名キャッシュ（workspace 内外を問わず）
const userNameCache = new Map(); // key: userId -> { name, ts }
const CACHE_TTL_MS = 1000 * 60 * 30; // 30分

function cacheGetName(id) {
  const hit = userNameCache.get(id);
  if (hit && (Date.now() - hit.ts) < CACHE_TTL_MS) return hit.name;
  return null;
}

async function resolveUserName(client, userId) {
  // 1) キャッシュ
  const cached = cacheGetName(userId);
  if (cached) return cached;

  // 2) users.info（Slack Connect 外部も多くは取得可）
  try {
    const u = await client.users.info({ user: userId });
    const prof = u?.user?.profile || {};
    const name =
      prof.real_name?.trim() ||
      prof.display_name?.trim() ||
      u?.user?.name?.trim() ||
      userId;

    userNameCache.set(userId, { name, ts: Date.now() });
    return name;
  } catch (e) {
    const fallback = userId;
    userNameCache.set(userId, { name: fallback, ts: Date.now() });
    return fallback;
  }
}

function pickTeamIdFallback(teamIdFromClient) {
  return teamIdFromClient || TEAM_ID_ENV || undefined;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function buildTextWithMention(baseText, mentionPlan) {
  // mentionPlan = {mode: "channel"|"here"|"everyone"|"user", userId?, userName?}
  if (!mentionPlan || !mentionPlan.mode) return baseText;
  switch (mentionPlan.mode) {
    case "channel":   return `<!channel> ${baseText}`;
    case "here":      return `<!here> ${baseText}`;
    case "everyone":  return `<!everyone> ${baseText}`;
    case "user":
      if (mentionPlan.userId) return `<@${mentionPlan.userId}> ${baseText}`;
      return baseText;
    default: return baseText;
  }
}

function safeJson(res, payload, status = 200) {
  res.status(status).json(payload);
}

// ------------------------------------
// API: ボットの見えるチャンネル一覧（public/招待済みprivate）
// ------------------------------------
app.get("/api/channels", async (req, res, next) => {
  try {
    if (!bot) return safeJson(res, [], 200);

    const out = [];
    let cursor;
    do {
      const resp = await bot.conversations.list({
        limit: 1000,
        cursor,
        types: "public_channel,private_channel"
      });
      (resp.channels || []).forEach(c => {
        out.push({ id: c.id, name: c.name, is_private: !!c.is_private });
      });
      cursor = resp.response_metadata?.next_cursor;
    } while (cursor);
    safeJson(res, out);
  } catch (e) { next(e); }
});

// ------------------------------------
// API: ワークスペースのユーザー一覧（DM向け）
// ------------------------------------
app.get("/api/users", async (req, res, next) => {
  try {
    if (!bot) return safeJson(res, [], 200);
    const users = [];
    let cursor;
    do {
      const resp = await bot.users.list({ limit: 1000, cursor });
      (resp.members || [])
        .filter(u => !u.deleted && !u.is_bot)
        .forEach(u => {
          const name = u.profile?.real_name || u.name || u.id;
          users.push({ id: u.id, name });
          // キャッシュにも入れておく（内部ユーザー高速化）
          userNameCache.set(u.id, { name, ts: Date.now() });
        });
      cursor = resp.response_metadata?.next_cursor;
    } while (cursor);
    safeJson(res, users);
  } catch (e) { next(e); }
});

// ------------------------------------
// API: 指定チャンネルのメンバー一覧（bot / userToken）
// GET /api/channel-members?channel=C123&mode=bot|user&teamId=... （user時）
// Header x-user-token でもOK
// ------------------------------------
app.get("/api/channel-members", async (req, res, next) => {
  try {
    const channel = req.query.channel;
    const mode = (req.query.mode || "bot").toLowerCase();
    const teamId = pickTeamIdFallback(req.query.teamId);
    const userToken = req.query.userToken || req.header("x-user-token");

    if (!channel) return safeJson(res, [], 200);

    const client = (mode === "user" && userToken)
      ? new WebClient(userToken)
      : bot;

    if (!client) return safeJson(res, [], 200);

    // 1) メンバーID一覧
    const memberIds = [];
    let cursor;
    do {
      const resp = await client.conversations.members({
        channel,
        limit: 1000,
        cursor,
        ...(teamId ? { team_id: teamId } : {})
      });
      (resp.members || []).forEach(id => memberIds.push(id));
      cursor = resp.response_metadata?.next_cursor;
    } while (cursor);

    // 2) ID -> 名前解決（外部も可能な限り）
    const out = [];
    for (const uid of memberIds) {
      const name = await resolveUserName(client, uid);
      out.push({ id: uid, name });
      await sleep(50); // 軽いレート制御
    }

    safeJson(res, out);
  } catch (e) { next(e); }
});

// ------------------------------------
// API: 個人トークン(xoxp)の検証とチャンネル抽出
// POST /api/personal/verify { userToken, teamId? }
// ------------------------------------
app.post("/api/personal/verify", async (req, res, next) => {
  try {
    const userToken = req.body?.userToken;
    const teamId = pickTeamIdFallback(req.body?.teamId);
    if (!userToken) return safeJson(res, { ok: false, error: "token_required" }, 400);

    const userClient = new WebClient(userToken);

    // 1) ユーザー確認
    const auth = await userClient.auth.test();
    const userId = auth.user_id;
    const userName = auth.user;

    // 2) 所属チャンネル
    const memberChannels = [];
    let cursor;
    do {
      const resp = await userClient.conversations.list({
        limit: 1000,
        cursor,
        types: "public_channel,private_channel",
        ...(teamId ? { team_id: teamId } : {})
      });
      (resp.channels || []).forEach(c => {
        if (c.is_member) {
          memberChannels.push({ id: c.id, name: c.name, is_private: !!c.is_private });
        }
      });
      cursor = resp.response_metadata?.next_cursor;
    } while (cursor);

    // 3) パブリック全体（参考）
    const publicChannels = [];
    cursor = undefined;
    do {
      const resp = await userClient.conversations.list({
        limit: 1000,
        cursor,
        types: "public_channel",
        ...(teamId ? { team_id: teamId } : {})
      });
      (resp.channels || []).forEach(c => {
        publicChannels.push({ id: c.id, name: c.name, is_private: !!c.is_private });
      });
      cursor = resp.response_metadata?.next_cursor;
    } while (cursor);

    safeJson(res, {
      ok: true,
      user: { id: userId, name: userName },
      memberChannels,
      publicChannels
    });
  } catch (e) { next(e); }
});

// ------------------------------------
// API: 送信（bot / userToken）
// body: { message, summary, channelIds[], userIds[], autoJoinPublic, perChannelMentions{chId:{mode,userId}}, mode, userToken?, teamId? }
// ------------------------------------
app.post("/api/broadcast", async (req, res, next) => {
  try {
    const {
      message,
      summary,
      channelIds = [],
      userIds = [],
      autoJoinPublic = false,
      perChannelMentions = {},
      mode = "bot",
      userToken,
      teamId
    } = req.body || {};

    if (!message || (!channelIds.length && !userIds.length)) {
      return safeJson(res, { ok: false, error: "invalid_params" }, 400);
    }

    const sendClient = (mode === "user" && userToken)
      ? new WebClient(userToken)
      : bot;

    if (!sendClient) {
      return safeJson(res, { ok: false, error: "no_token" }, 400);
    }

    const effectiveTeam = pickTeamIdFallback(teamId);
    const results = [];

    // 1) チャンネル送信
    for (const ch of channelIds) {
      if (autoJoinPublic && sendClient === bot) {
        try { await sendClient.conversations.join({ channel: ch }); } catch {}
      }
      const plan = perChannelMentions[ch] || { mode: "channel" };
      const text = buildTextWithMention(message, plan);

      try {
        const r = await sendClient.chat.postMessage({
          channel: ch,
          text,
          ...(effectiveTeam ? { team: effectiveTeam } : {})
        });
        results.push({ ok: r.ok, channel: ch, ts: r.ts });

        if (summary && r.ok && r.channel && r.ts) {
          const thr = "```\n" + summary + "\n```";
          await sendClient.chat.postMessage({
            channel: r.channel,
            thread_ts: r.ts,
            text: thr
          });
        }
      } catch (e) {
        results.push({ ok: false, channel: ch, error: e?.data?.error || e.message });
      }
      await sleep(250);
    }

    // 2) DM 送信
    for (const uid of userIds) {
      try {
        const im = await sendClient.conversations.open({ users: uid, ...(effectiveTeam ? { team_id: effectiveTeam } : {}) });
        const r = await sendClient.chat.postMessage({ channel: im.channel.id, text: message });
        results.push({ ok: r.ok, channel: im.channel.id, ts: r.ts, dm_to: uid });

        if (summary && r.ok && r.channel && r.ts) {
          const thr = "```\n" + summary + "\n```";
          await sendClient.chat.postMessage({
            channel: r.channel,
            thread_ts: r.ts,
            text: thr
          });
        }
      } catch (e) {
        results.push({ ok: false, dm_to: uid, error: e?.data?.error || e.message });
      }
      await sleep(250);
    }

    // 直近送信の保持（取り消し用）
    lastBroadcast = {
      id: `b${Date.now()}`,
      mode,
      token: mode === "user" ? userToken : SLACK_BOT_TOKEN,
      results: results
        .filter(r => r.ok && r.channel && r.ts)
        .map(r => ({ channel: r.channel, ts: r.ts }))
    };

    safeJson(res, {
      ok: results.every(r => r.ok),
      broadcast_id: lastBroadcast.id,
      results
    });
  } catch (e) { next(e); }
});

// ------------------------------------
// API: 直前の送信を取り消す（削除）
// ------------------------------------
app.post("/api/broadcast/undo-last", async (req, res, next) => {
  try {
    if (!lastBroadcast || !lastBroadcast.results?.length) {
      return safeJson(res, { ok: false, error: "no_last_broadcast" }, 400);
    }
    const client = new WebClient(lastBroadcast.token);
    const results = [];
    for (const item of lastBroadcast.results) {
      try {
        const r = await client.chat.delete({
          channel: item.channel,
          ts: item.ts
        });
        results.push({ ok: r.ok, channel: item.channel, ts: item.ts });
      } catch (e) {
        results.push({ ok: false, channel: item.channel, ts: item.ts, error: e?.data?.error || e.message });
      }
      await sleep(200);
    }
    lastBroadcast = null;
    safeJson(res, { ok: results.every(r => r.ok), results });
  } catch (e) { next(e); }
});

// ------------------------------------
// エラーハンドラ（JSONで返す）
// ------------------------------------
app.use((err, req, res, next) => {
  console.error("[API Error]", err);
  safeJson(res, { ok: false, error: err?.data?.error || err?.message || "internal_error" }, 500);
});

// ------------------------------------
// 静的配信（最後）
// ------------------------------------
app.use(express.static(path.join(process.cwd(), "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

// ------------------------------------
app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
});
