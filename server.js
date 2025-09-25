// server.js — テキスト一斉送信 / チャンネルごとにメンション指定 / DM対応
//           案件概要はスレッド返信でコードブロック投稿（メンションしない）
import express from "express";
import basicAuth from "express-basic-auth";
import { WebClient } from "@slack/web-api";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

/* ===== Basic 認証（任意） ===== */
const { BASIC_USER, BASIC_PASS } = process.env;
if (BASIC_USER && BASIC_PASS) {
  app.use(
    basicAuth({
      users: { [BASIC_USER]: BASIC_PASS },
      challenge: true,
      realm: "SendSlack",
    })
  );
}

/* ===== Slack ===== */
const client = new WebClient(process.env.SLACK_BOT_TOKEN);
// 必要スコープ（Bot Token Scopes）:
// chat:write, channels:read, users:read, im:write
// 追加: groups:read（プラベCHの表示/送信）, channels:join（公開CH自動参加）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isChannelId = (id) => id?.startsWith("C") || id?.startsWith("G"); // C=public, G=private

async function joinIfPublic(client, channel) {
  try {
    const info = await client.conversations.info({ channel });
    if (!info.channel?.is_private) await client.conversations.join({ channel });
  } catch {
    /* 既参加/権限不足などは無視 */
  }
}

/* ===== Utils: コードブロック整形（文字列/配列/オブジェクト対応） ===== */
const extractText = (x) => {
  if (x == null) return "";
  if (typeof x === "string") return x;
  if (Array.isArray(x)) return x.map(extractText).filter(Boolean).join("\n");
  if (typeof x === "object") {
    const cands = [x.plain_text, x.text, x.content, x.value, x.body, x.message, x.description, x.title]
      .filter((v) => typeof v === "string" && v.trim());
    if (cands.length) return cands[0];
    const keys = Object.keys(x);
    if (keys.length === 0) return "";
    try { return JSON.stringify(x, null, 2); } catch { return String(x); }
  }
  return String(x);
};
const toCodeBlock = (x) => {
  const s = extractText(x);
  if (!s || !s.trim()) return "";
  const safe = s.replace(/```/g, "\u200B```"); // ``` の入れ子対策
  return "```\n" + safe + "\n```";
};

/* ===== API: チャンネル一覧（公開/非公開） ===== */
app.get("/api/channels", async (_req, res) => {
  try {
    const types = "public_channel,private_channel";
    const channels = [];
    let cursor;
    do {
      const r = await client.conversations.list({ types, limit: 200, cursor });
      channels.push(...(r.channels || []));
      cursor = r.response_metadata?.next_cursor;
    } while (cursor);

    res.json(
      channels.map((c) => ({
        id: c.id,
        name: c.name || c.user || c.id,
        is_private: !!c.is_private,
      }))
    );
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "channels_list_failed" });
  }
});

/* ===== API: ユーザー一覧（DM候補 & 全体検索用） ===== */
app.get("/api/users", async (_req, res) => {
  try {
    const users = [];
    let cursor;
    do {
      const r = await client.users.list({ limit: 200, cursor }); // users:read
      users.push(...(r.members || []));
      cursor = r.response_metadata?.next_cursor;
    } while (cursor);

    res.json(
      users
        .filter((u) => !u.deleted && !u.is_bot)
        .map((u) => ({
          id: u.id,
          name: u.profile?.display_name || u.real_name || u.name,
        }))
    );
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "users_list_failed" });
  }
});

/* ===== API: チャンネルのメンバー一覧（外部含む） ===== */
app.get("/api/channel-members", async (req, res) => {
  try {
    const { channel } = req.query;
    if (!channel) return res.status(400).json({ ok: false, error: "no_channel" });

    let cursor, ids = [];
    do {
      const r = await client.conversations.members({ channel, limit: 200, cursor }); // channels:read / groups:read
      ids.push(...(r.members || []));
      cursor = r.response_metadata?.next_cursor;
    } while (cursor);

    const members = [];
    for (const id of ids) {
      try {
        const u = await client.users.info({ user: id }); // users:read
        members.push({
          id,
          name: u.user?.profile?.display_name || u.user?.real_name || u.user?.name || id,
        });
      } catch {}
    }
    res.json(members);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "channel_members_failed" });
  }
});

/* ===== API: 一括送信 =====
   - チャンネル宛は「チャンネルごと」にメンション指定（@channel/@here/@everyone/指定ユーザー）
   - DM宛にはメンションしない
   - summary があれば、本体投稿のスレッドにコードブロックで返信（メンションなし）
*/
app.post("/api/broadcast", async (req, res) => {
  const {
    message,
    summary = "",
    channelIds = [],
    userIds = [],
    autoJoinPublic = true,
    // { [channelId]: { mode: "channel"|"here"|"everyone"|"user", userId?: "U..." } }
    perChannelMentions = {},
  } = req.body || {};

  if (!message || (!channelIds.length && !userIds.length)) {
    return res.status(400).json({ ok: false, error: "bad_request" });
  }
  // すべての選択チャンネルについてメンションがセットされているか検証
  for (const ch of channelIds) {
    const m = perChannelMentions[ch];
    if (!m || !m.mode || (m.mode === "user" && !m.userId)) {
      return res.status(400).json({ ok: false, error: `mention_required_for_${ch}` });
    }
  }

  try {
    // 宛先（チャンネル + DM）
    const targets = [...channelIds];
    for (const uid of userIds) {
      try {
        const opened = await client.conversations.open({ users: uid }); // im:write
        if (opened.ok && opened.channel?.id) targets.push(opened.channel.id);
      } catch {}
    }

    const buildMention = (ch) => {
      if (!isChannelId(ch)) return ""; // DMには付けない
      const m = perChannelMentions[ch] || { mode: "channel" };
      switch (m.mode) {
        case "channel":  return "<!channel>";
        case "here":     return "<!here>";
        case "everyone": return "<!everyone>";
        case "user":     return m.userId ? `<@${m.userId}>` : "";
        default:         return "<!channel>";
      }
    };

    const results = [];
    for (const ch of targets) {
      try {
        if (autoJoinPublic && isChannelId(ch)) await joinIfPublic(client, ch);

        const prefix = buildMention(ch);
        const text = prefix ? `${prefix} ${message}` : message;

        // 本体メッセージ
        const main = await client.chat.postMessage({ channel: ch, text }); // chat:write

        // 概要をスレッド返信（メンションなし）
        if (summary && main.ok && main.ts) {
          const code = toCodeBlock(summary);
          if (code) {
            await client.chat.postMessage({
              channel: ch,
              thread_ts: main.ts,
              text: "案件概要",
              blocks: [{ type: "section", text: { type: "mrkdwn", text: code } }],
              unfurl_links: false,
              unfurl_media: false,
            });
          }
        }

        results.push({ channel: ch, ok: main.ok, ts: main.ts });
      } catch (e) {
        results.push({ channel: ch, ok: false, error: String(e) });
      }
      await sleep(250);
    }

    res.json({ ok: true, count: targets.length, results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "broadcast_failed" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`SendSlack running on http://localhost:${port}`));
