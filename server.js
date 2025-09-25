// server.js — DB永続化版（SQLite）
// 一斉送信（チャンネル別メンション/DM）+ 確認UI + 履歴API + 取り消し（直前/ID指定）
// 案件概要はスレッド返信(コードブロック) / Slack内［削除］ボタン / DB保存
import express from "express";
import basicAuth from "express-basic-auth";
import { WebClient } from "@slack/web-api";
import dotenv from "dotenv";
import crypto from "crypto";
import Database from "better-sqlite3";
dotenv.config();



const SHOW_DELETE_BUTTON = String(process.env.SHOW_DELETE_BUTTON || "true").toLowerCase() === "true";
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
// 必要スコープ: chat:write, channels:read, users:read, im:write
// 追加: groups:read（プラベCH）, channels:join（公開CH自動参加）

/* ===== SQLite 初期化 ===== */
const db = new Database("data.db");
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS broadcasts (
  id TEXT,                -- 送信回を識別するID（同じidで複数行＝複数宛先）
  channel TEXT,           -- 送信先チャンネル/IM ID
  main_ts TEXT,           -- 本文メッセージ ts
  summary_ts TEXT,        -- 案件概要の返信 ts（なければNULL）
  created_at INTEGER,     -- ミリ秒
  message_preview TEXT    -- 本文の先頭160字
);
CREATE INDEX IF NOT EXISTS idx_broadcasts_id ON broadcasts(id);
CREATE INDEX IF NOT EXISTS idx_broadcasts_created ON broadcasts(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcasts_main_ts ON broadcasts(main_ts);
`);

const stmtInsert = db.prepare(
  "INSERT OR REPLACE INTO broadcasts (id, channel, main_ts, summary_ts, created_at, message_preview) VALUES (?, ?, ?, ?, ?, ?)"
);
const stmtSelectGroupPage = db.prepare(`
  SELECT id,
         MIN(created_at) AS created_at,
         COUNT(*)        AS count,
         GROUP_CONCAT(channel) AS channels,
         MAX(message_preview)  AS message_preview
  FROM broadcasts
  GROUP BY id
  ORDER BY created_at DESC
  LIMIT ? OFFSET ?
`);
const stmtSelectLatestId = db.prepare(`
  SELECT id
  FROM broadcasts
  GROUP BY id
  ORDER BY MAX(created_at) DESC
  LIMIT 1
`);
const stmtSelectById = db.prepare(`SELECT * FROM broadcasts WHERE id = ?`);
const stmtDeleteById = db.prepare(`DELETE FROM broadcasts WHERE id = ?`);
const stmtDeleteByMainTs = db.prepare(`DELETE FROM broadcasts WHERE main_ts = ?`);

/* ===== 小物 ===== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isChannelId = (id) => id?.startsWith("C") || id?.startsWith("G"); // C=public, G=private
const newBroadcastId = () => "b" + Date.now() + Math.random().toString(36).slice(2, 8);

async function joinIfPublic(client, channel) {
  try {
    const info = await client.conversations.info({ channel });
    if (!info.channel?.is_private) await client.conversations.join({ channel });
  } catch {/* 既参加/権限不足は無視 */}
}

/* 文字列抽出 → コードブロック */
const extractText = (x) => {
  if (x == null) return "";
  if (typeof x === "string") return x;
  if (Array.isArray(x)) return x.map(extractText).filter(Boolean).join("\n");
  if (typeof x === "object") {
    const cands = [x.plain_text, x.text, x.content, x.value, x.body, x.message, x.description, x.title]
      .filter((v) => typeof v === "string" && v.trim());
    if (cands.length) return cands[0];
    try { return JSON.stringify(x, null, 2); } catch { return String(x); }
  }
  return String(x);
};
const toCodeBlock = (x) => {
  const s = extractText(x);
  if (!s || !s.trim()) return "";
  const safe = s.replace(/```/g, "\u200B```"); // 入れ子対策
  return "```\n" + safe + "\n```";
};

/* ===== API: チャンネル一覧 ===== */
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

/* ===== API: ユーザー一覧（DM候補） ===== */
app.get("/api/users", async (_req, res) => {
  try {
    const users = [];
    let cursor;
    do {
      const r = await client.users.list({ limit: 200, cursor });
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

/* ===== API: チャンネルのメンバー一覧 ===== */
app.get("/api/channel-members", async (req, res) => {
  try {
    const { channel } = req.query;
    if (!channel) return res.status(400).json({ ok: false, error: "no_channel" });

    let cursor, ids = [];
    do {
      const r = await client.conversations.members({ channel, limit: 200, cursor });
      ids.push(...(r.members || []));
      cursor = r.response_metadata?.next_cursor;
    } while (cursor);

    const members = [];
    for (const id of ids) {
      try {
        const u = await client.users.info({ user: id });
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

/* ===== API: 履歴一覧（DBから取得） =====
   GET /api/broadcast/history?limit=50&offset=0
*/
app.get("/api/broadcast/history", (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const rows = stmtSelectGroupPage.all(limit, offset);
    const history = rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      count: r.count,
      channels: (r.channels || "").split(",").filter(Boolean),
      messagePreview: r.message_preview || "",
    }));
    res.json({ ok: true, history });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "history_failed" });
  }
});

/* ===== API: 一括送信 =====
   Body:
     message, summary, channelIds[], userIds[],
     autoJoinPublic,
     perChannelMentions: { [chId]: { mode: "channel"|"here"|"everyone"|"user", userId?: "U..." } }
*/
app.post("/api/broadcast", async (req, res) => {
  const {
    message,
    summary = "",
    channelIds = [],
    userIds = [],
    autoJoinPublic = true,
    perChannelMentions = {},
  } = req.body || {};

  if (!message || (!channelIds.length && !userIds.length)) {
    return res.status(400).json({ ok: false, error: "bad_request" });
  }
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
        const opened = await client.conversations.open({ users: uid });
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
    const now = Date.now();
    const broadcastId = newBroadcastId();

    for (const ch of targets) {
      try {
        if (autoJoinPublic && isChannelId(ch)) await joinIfPublic(client, ch);

        const prefix = buildMention(ch);
        const text = prefix ? `${prefix} ${message}` : message;

        // 本体（削除ボタン付き）
        const main = await client.chat.postMessage({
          channel: ch,
          text,
          blocks: [
            { type: "section", text: { type: "mrkdwn", text } }
          ]
        });

        // 案件概要 → スレッド返信（コードブロック）
        let summaryTs = null;
        if (summary && main.ok && main.ts) {
          const code = toCodeBlock(summary);
          if (code) {
            const rep = await client.chat.postMessage({
              channel: ch,
              thread_ts: main.ts,
              text: "案件概要",
              blocks: [{ type: "section", text: { type: "mrkdwn", text: code } }],
              unfurl_links: false,
              unfurl_media: false,
            });
            summaryTs = rep?.ts || null;
          }
        }

        // DB保存（1宛先=1行）
        stmtInsert.run(
          broadcastId, ch, main.ts || null, summaryTs, now, message.slice(0, 160)
        );

        results.push({ channel: ch, ok: main.ok, ts: main.ts });
      } catch (e) {
        results.push({ channel: ch, ok: false, error: String(e) });
      }
      await sleep(250);
    }

    return res.json({ ok: true, broadcast_id: broadcastId, count: targets.length, results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "broadcast_failed" });
  }
});

/* ===== 取り消し（直前 / ID指定） ===== */
async function undoByIdFromDB(id) {
  const items = stmtSelectById.all(id);
  const results = [];
  for (const it of items) {
    try {
      if (it.summary_ts) await client.chat.delete({ channel: it.channel, ts: it.summary_ts });
      if (it.main_ts) await client.chat.delete({ channel: it.channel, ts: it.main_ts });
      results.push({ channel: it.channel, ok: true });
    } catch (e) {
      results.push({ channel: it.channel, ok: false, error: String(e) });
    }
    await sleep(150);
  }
  // DBから消去
  stmtDeleteById.run(id);
  return results;
}

app.post("/api/broadcast/undo-last", async (_req, res) => {
  try {
    const row = stmtSelectLatestId.get();
    if (!row?.id) return res.status(400).json({ ok: false, error: "nothing_to_undo" });
    const results = await undoByIdFromDB(row.id);
    res.json({ ok: true, undone_broadcast_id: row.id, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: "undo_failed" });
  }
});

app.post("/api/broadcast/:id/undo", async (req, res) => {
  try {
    const id = req.params.id;
    const has = stmtSelectById.get(id);
    if (!has) return res.status(404).json({ ok: false, error: "not_found" });
    const results = await undoByIdFromDB(id);
    res.json({ ok: true, undone_broadcast_id: id, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: "undo_failed" });
  }
});

/* ===== Slack インタラクション（削除ボタン） =====
   ボタンクリックで削除が成功したら、DB側の該当行も掃除（main_ts一致）します。
*/
function verifySlackSignature(req, rawBody) {
  const ts = req.headers["x-slack-request-timestamp"];
  const sig = req.headers["x-slack-signature"];
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 60 * 5) return false; // 5分

  const base = `v0:${ts}:${rawBody}`;
  const hmac = crypto.createHmac("sha256", process.env.SLACK_SIGNING_SECRET || "");
  hmac.update(base);
  const my = `v0=${hmac.digest("hex")}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(my), Buffer.from(sig));
  } catch {
    return false;
  }
}

app.post(
  "/slack/interactive",
  express.raw({ type: "application/x-www-form-urlencoded" }),
  async (req, res) => {
    const raw = req.body?.toString?.() || "";
    if (!verifySlackSignature(req, raw)) return res.status(401).send("bad signature");

    const params = new URLSearchParams(raw);
    const payloadStr = params.get("payload") || "{}";
    const payload = JSON.parse(payloadStr);

    if (payload.type === "block_actions") {
      const action = payload.actions?.[0];
      const channel = payload.channel?.id;
      const messageTs = payload.message?.ts;
      const userId = payload.user?.id;

      if (action?.action_id === "delete_broadcast" && channel && messageTs) {
        try {
          // 返信も先に削除
          const rep = await client.conversations.replies({ channel, ts: messageTs, limit: 200 });
          for (const m of rep.messages || []) {
            if (m.ts !== messageTs) {
              try { await client.chat.delete({ channel, ts: m.ts }); } catch {}
            }
          }
          await client.chat.delete({ channel, ts: messageTs });

          // DB掃除：この親メッセージに対応する行を削除
          try { stmtDeleteByMainTs.run(messageTs); } catch {}

          // 実行者にだけ見える通知
          try {
            await client.chat.postEphemeral({ channel, user: userId, text: "削除しました。" });
          } catch {}
          return res.status(200).end();
        } catch (e) {
          try {
            await client.chat.postEphemeral({
              channel, user: userId, text: `削除に失敗しました: ${e.data?.error || e.message}`
            });
          } catch {}
          return res.status(200).end();
        }
      }
    }
    return res.status(200).end();
  }
);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`SendSlack running on http://localhost:${port}`));
