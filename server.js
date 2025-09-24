// server.js（ESM版）
import express from "express";
import { WebClient } from "@slack/web-api";
import dotenv from "dotenv";
import multer from "multer";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

const client = new WebClient(process.env.SLACK_BOT_TOKEN);
const s3 = new S3Client({ region: process.env.AWS_REGION });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB 例
});


// 軽いウェイト（429対策）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 公開CHなら自動Join（privateは不可）
async function joinIfPublic(client, channel) {
  try {
    const info = await client.conversations.info({ channel });
    const isPrivate = info.channel?.is_private;
    if (!isPrivate) await client.conversations.join({ channel }); // channels:join
  } catch {
    // 既にメンバー/権限不足/プライベート等は無視
  }
}

// ユーザーとのDMを開く（im:write）→ channel.id 取得
async function openDmChannel(userId) {
  const opened = await client.conversations.open({ users: userId });
  if (!opened.ok) throw new Error(opened.error || "open_dm_failed");
  return opened.channel?.id;
}

// 1) チャンネル一覧（公開/非公開）
app.get("/api/channels", async (req, res) => {
  try {
    const types = "public_channel,private_channel"; // DM/MPIMはユーザー選択で対応
    const channels = [];
    let cursor;
    do {
      const resp = await client.conversations.list({ types, limit: 200, cursor });
      channels.push(...(resp.channels || []));
      cursor = resp.response_metadata?.next_cursor;
    } while (cursor);

    const payload = channels.map((c) => ({
      id: c.id,
      name: c.name || c.user || c.id,
      is_private: !!c.is_private,
    }));
    res.json(payload);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "channels_list_failed" });
  }
});

// 2) ユーザー一覧（DM宛先候補）
app.get("/api/users", async (req, res) => {
  try {
    const users = [];
    let cursor;
    do {
      const resp = await client.users.list({ limit: 200, cursor }); // users:read
      users.push(...(resp.members || []));
      cursor = resp.response_metadata?.next_cursor;
    } while (cursor);

    const payload = users
      .filter((u) => !u.deleted && !u.is_bot)
      .map((u) => ({
        id: u.id,
        name: u.profile?.display_name || u.real_name || u.name,
      }));
    res.json(payload);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "users_list_failed" });
  }
});
// D&Dファイルを受け取って一括共有
app.post("/api/upload-share", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    const title = req.body?.title || (file?.originalname ?? "uploaded file");
    const message = req.body?.message || "";
    const channelIds = JSON.parse(req.body?.channelIds || "[]"); // ["Cxxx","Gyyy"]
    const userIds    = JSON.parse(req.body?.userIds || "[]");    // ["Uxxx","Uyyy"]
    const autoJoinPublic = String(req.body?.autoJoinPublic ?? "true") === "true";

    if (!file) return res.status(400).json({ ok:false, error:"no_file" });
    if (channelIds.length === 0 && userIds.length === 0) {
      return res.status(400).json({ ok:false, error:"no_targets" });
    }

    // 0) DM をチャンネルIDに変換
    const targets = [...channelIds];
    for (const uid of userIds) {
      try {
        const dm = await client.conversations.open({ users: uid }); // im:write
        if (dm.ok && dm.channel?.id) targets.push(dm.channel.id);
      } catch (e) {
        console.warn("openDm failed:", uid, e?.message || e);
      }
    }

    // 1) S3にアップロード
    const key = `${process.env.S3_PREFIX || ""}${Date.now()}_${encodeURIComponent(file.originalname)}`;
    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      // 公開バケット運用なら ACL は不要。必要に応じて:
      // ACL: "public-read",
    }));

    // 2) Slackが参照するURLを組み立て（署名URL or 公開URL）
    let externalUrl;
    if (process.env.S3_PUBLIC_BASE_URL) {
      const base = process.env.S3_PUBLIC_BASE_URL.replace(/\/+$/,"");
      externalUrl = `${base}/${key}`;
    } else {
      // 署名URL（既定）。クリック時に有効であればOK
      const expires = Number(process.env.S3_URL_EXPIRES || 3600);
      externalUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }),
        { expiresIn: expires }
      );
    }

    // 3) Remote File として一度だけ登録
    const add = await client.files.remote.add({
      external_id: key,        // 任意の一意ID（keyを使う）
      external_url: externalUrl,
      title,
      // filetype は省略可。検索用に本文を入れたいなら indexable_file_contents も可
    });
    if (!add.ok) return res.status(500).json(add);

    // 4) 宛先ごとに共有（＋必要ならテキストも投稿）
    const results = [];
    for (const ch of targets) {
      try {
        if (autoJoinPublic) await joinIfPublic(client, ch); // 公開CHなら参加を試みる
        const shared = await client.files.remote.share({
          external_id: key,
          channels: ch,
        });
        if (message) {
          await client.chat.postMessage({ channel: ch, text: message }); // 任意の本文
        }
        results.push({ channel: ch, ok: shared.ok, error: shared.error || null });
      } catch (e) {
        results.push({ channel: ch, ok: false, error: String(e) });
      }
      await sleep(250);
    }

    res.json({ ok:true, externalUrl, title, count: targets.length, results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error: e?.message || "upload_share_failed" });
  }
});

// 3) ブロードキャスト（テキスト・ファイル・DM対応）
app.post("/api/broadcast", async (req, res) => {
  const {
    mode = "text",        // "text" | "file" | "both"
    fileUrl,              // リモートファイルURL（S3/SharePoint等）
    title,                // ファイルタイトル
    message,              // テキスト本文（任意）
    channelIds = [],      // チャンネル宛先
    userIds = [],         // DM宛先（ユーザーID）
    autoJoinPublic = true // 公開CHに未参加ならJoinを試す
  } = req.body || {};

  if ((mode === "file" || mode === "both") && !fileUrl) {
    return res.status(400).json({ ok: false, error: "file_url_required" });
  }
  if (channelIds.length === 0 && userIds.length === 0) {
    return res.status(400).json({ ok: false, error: "no_targets" });
  }

  try {
    // 送信先チャンネル（CH + DM(=open)）
    const targets = [...channelIds];
    for (const uid of userIds) {
      try {
        const dmCh = await openDmChannel(uid); // im:write
        if (dmCh) targets.push(dmCh);
      } catch (e) {
        console.warn("openDm failed:", uid, e?.message || e);
      }
    }

    // ファイル送信が必要な場合は、最初に1回だけリモート登録
    let remoteFileId, externalId;
    if (mode !== "text") {
      const added = await client.apiCall("files.remote.add", {
        external_url: fileUrl,
        title: title || "shared file",
      });
      if (!added.ok) return res.status(400).json(added);
      remoteFileId = added.file?.id;
      externalId = added.file?.external_id;
    }

    // 宛先ごとに送信
    const results = [];
    for (const ch of targets) {
      try {
        if (autoJoinPublic) await joinIfPublic(client, ch);

        // テキスト
        if (mode === "text" || mode === "both") {
          await client.chat.postMessage({
            channel: ch,
            text: message || "", // blocksにしたい場合はここを拡張
          });
        }

        // ファイル
        if (mode === "file" || mode === "both") {
          const r = await client.apiCall("files.remote.share", {
            file: remoteFileId, // or external_id: externalId
            channels: ch,
          });
          results.push({ channel: ch, ok: r.ok, error: r.error || null });
        } else {
          results.push({ channel: ch, ok: true, error: null });
        }
      } catch (err) {
        results.push({ channel: ch, ok: false, error: String(err) });
      }
      await sleep(300); // 軽いレート制限ケア
    }

    res.json({
      ok: true,
      mode,
      remoteFileId,
      externalId,
      count: targets.length,
      results,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "broadcast_failed" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () =>
  console.log(`SendSlack running on http://<your-ip>:${port}`)
);
