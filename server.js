// server.js  (package.json に "type": "module" がある前提)
import path from "node:path";
import express from "express";
import dotenv from "dotenv";
import { WebClient } from "@slack/web-api";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN; // xoxb-***
const TEAM_ID_ENV = process.env.TEAM_ID || "";       // 任意

const bot = SLACK_BOT_TOKEN ? new WebClient(SLACK_BOT_TOKEN) : null;

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

let lastBroadcast = null; // { id, mode, token, results:[{channel,ts}] }

// util
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pickTeamIdFallback = (teamIdFromClient) => teamIdFromClient || TEAM_ID_ENV || undefined;
const safeJson = (res, payload, status = 200) => res.status(status).json(payload);

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
    const users = [];
    let cursor;
    do {
      const r = await bot.users.list({ limit:1000, cursor });
      (r.members || [])
        .filter(u => !u.deleted && !u.is_bot)
        .forEach(u => users.push({ id:u.id, name: u.profile?.real_name || u.name || u.id }));
      cursor = r.response_metadata?.next_cursor;
    } while (cursor);
    safeJson(res, users);
  } catch (e) { next(e); }
});

// ------------- API: 指定CHのメンバー一覧（bot / userToken） -------------
app.get("/api/channel-members", async (req, res, next) => {
  try {
    const { channel } = req.query;
    const mode = (req.query.mode || "bot").toLowerCase();
    const teamId = pickTeamIdFallback(req.query.teamId);
    const userToken = req.query.userToken || req.header("x-user-token");

    const client = (mode === "user" && userToken) ? new WebClient(userToken) : bot;
    if (!channel || !client) return safeJson(res, [], 200);

    const ids = [];
    let cursor;
    do {
      const r = await client.conversations.members({
        channel, limit: 1000, cursor, ...(teamId ? { team_id: teamId } : {})
      });
      (r.members || []).forEach(id => ids.push(id));
      cursor = r.response_metadata?.next_cursor;
    } while (cursor);

    // 名前解決（users.info）
    const out = [];
    for (const uid of ids) {
      try {
        const info = await client.users.info({ user: uid });
        const prof = info?.user?.profile || {};
        const name = prof.real_name?.trim() || prof.display_name?.trim() || info?.user?.name || uid;
        out.push({ id: uid, name });
      } catch {
        out.push({ id: uid, name: uid });
      }
      await sleep(30);
    }
    safeJson(res, out);
  } catch (e) { next(e); }
});

// ------------- API: 個人トークン検証 -------------
app.post("/api/personal/verify", async (req, res, next) => {
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
  if (plan.mode === "channel") return `<!channel>\ n ${text}`;
  if (plan.mode === "user") {
    const ids = (plan.users || []).map(u => u.id).filter(Boolean);
    if (ids.length) return `${ids.map(id => `<@${id}>`).join(" ")} \n ${text}`;
  }
  return text;
}

// ------------- API: 送信 -------------
app.post("/api/broadcast", async (req, res, next) => {
  try {
    const {
      message, summary,
      channelIds = [], userIds = [],
      autoJoinPublic = false,
      perChannelMentions = {},   // { chId: { mode:"channel"|"user", users?:[] } }
      mode = "bot",
      userToken, teamId
    } = req.body || {};

    if (!message || (!channelIds.length && !userIds.length)) {
      return safeJson(res, { ok:false, error:"invalid_params" }, 400);
    }

    const client = (mode === "user" && userToken) ? new WebClient(userToken) : bot;
    if (!client) return safeJson(res, { ok:false, error:"no_token" }, 400);

    const effectiveTeam = pickTeamIdFallback(teamId);
    const results = [];

    // CH メッセージ
    for (const ch of channelIds) {
      const plan = perChannelMentions[ch] || { mode:"channel" };
      const text = buildTextWithPlan(message, plan);

      if (autoJoinPublic && client === bot) {
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

    lastBroadcast = {
      id: `b${Date.now()}`, mode,
      token: mode === "user" ? userToken : SLACK_BOT_TOKEN,
      results: results.filter(r => r.ok && r.channel && r.ts).map(r => ({ channel:r.channel, ts:r.ts }))
    };

    safeJson(res, { ok: results.every(r => r.ok), broadcast_id: lastBroadcast.id, results });
  } catch (e) { next(e); }
});

// ------------- API: 取り消し -------------
app.post("/api/broadcast/undo-last", async (req, res, next) => {
  try {
    if (!lastBroadcast?.results?.length)
      return res.status(400).json({ ok: false, error: "no_last_broadcast" });

    const client = new WebClient(lastBroadcast.token);
    const results = [];

    for (const it of lastBroadcast.results) {
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

    lastBroadcast = null;
    res.json({ ok: results.every(r => r.ok), results });
  } catch (e) {
    next(e);
  }
});

// ------------- 静的配信 -------------
app.use(express.static(path.join(process.cwd(), "public")));
app.get("*", (req, res) => res.sendFile(path.join(process.cwd(), "public", "index.html")));

app.listen(PORT, () => console.log(`Server running: http://localhost:${PORT}`));
