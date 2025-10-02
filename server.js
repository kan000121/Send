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

// CORSが必要ならここで適宜
// app.use((req,res,next)=>{ res.setHeader("Access-Control-Allow-Origin","*"); ... })

// 直近送信の保存（取り消し用）
let lastBroadcast = null; // { results:[{channel,ts,mode,token}], mode }

// ------------------------------------
// helpers
// ------------------------------------
function pickTeamIdFallback(teamIdFromClient) {
  // 優先：クライアントから来た teamId → .env → 未指定
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
        .forEach(u => users.push({ id: u.id, name: u.profile?.real_name || u.name || u.id }));
      cursor = resp.response_metadata?.next_cursor;
    } while (cursor);
    safeJson(res, users);
  } catch (e) { next(e); }
});

// ------------------------------------
// API: 指定チャンネルのメンバー一覧（bot / userToken）
//  GET /api/channel-members?channel=C123&mode=bot|user&teamId=... （user時）
//  Bodyにも userToken を渡せます（GETなので本来はPOST推奨だが互換で）
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

    const members = [];
    let cursor;
    do {
      const resp = await client.conversations.members({
        channel,
        limit: 1000,
        cursor,
        ...(teamId ? { team_id: teamId } : {})
      });
      (resp.members || []).forEach(id => members.push(id));
      cursor = resp.response_metadata?.next_cursor;
    } while (cursor);

    // id→name 変換
    const out = [];
    for (let i = 0; i < members.length; i += 200) {
      const chunk = members.slice(i, i + 200);
      const prof = await client.users.info({ user: chunk[0] }).catch(()=>null); // preflight
      // users.info bulkは無いので最低限で：UIはIDでも十分。必要なら徐々に引く。
      // ここでは名前解決は必要最低限のみ（1件だけ）。全解決はコスト高なので省略。
      // ちゃんと全員の名前が必要なら users.list でキャッシュ→map がおすすめ。
    }
    // ここでは IDのみ返却。フロント側で users.list の結果と照合してください。
    const shaped = members.map(id => ({ id, name: id }));
    safeJson(res, shaped);
  } catch (e) { next(e); }
});

// ------------------------------------
// API: 個人トークン(xoxp)の検証とチャンネル抽出
// POST /api/personal/verify { userToken, teamId? }
// 返り値: { ok, user:{id,name}, memberChannels:[{id,name,is_private}], publicChannels:[...] }
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

    // 2) 所属チャンネル（public/private 含む）
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
        // 「所属している」チャンネルだけ拾いたい場合は is_member を確認
        if (c.is_member) {
          memberChannels.push({ id: c.id, name: c.name, is_private: !!c.is_private });
        }
      });
      cursor = resp.response_metadata?.next_cursor;
    } while (cursor);

    // 3) パブリック全体（参考：UI側で混在表示したい場合に）
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
//  body: { message, summary, channelIds[], userIds[], autoJoinPublic, perChannelMentions{chId:{mode,userId}}, mode: "bot"|"user", userToken?, teamId? }
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
      // 必要に応じて public auto-join（botのみ）
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

        // 案件概要をスレッドで（任意）
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
      await sleep(250); // レート制御控えめ
    }

    // 2) DM 送信（IM open → DMへ）
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
    // クリア
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
