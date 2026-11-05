// ログイン状態（Slack のユーザートークンを含む）を暗号化 Cookie で保持する
// サーバーにセッションを保存しないので、再起動・再デプロイ後もログインが続く
import crypto from "node:crypto";

export const SESSION_COOKIE = "send_session";
export const STATE_COOKIE = "send_oauth_state";

export function sessionKey(secret) {
  return Buffer.from(crypto.hkdfSync("sha256", secret, "send-session", "v1", 32));
}

// AES-256-GCM。形式: base64url(iv[12] | tag[16] | 暗号文)
export function seal(key, payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(SESSION_COOKIE));
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

// 改ざん・期限切れ・形式不正はすべて null
export function unseal(key, value) {
  try {
    const buf = Buffer.from(value, "base64url");
    if (buf.length < 29) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
    decipher.setAAD(Buffer.from(SESSION_COOKIE));
    decipher.setAuthTag(buf.subarray(12, 28));
    const payload = JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8"));
    return typeof payload?.exp === "number" && payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of (header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name && !Object.hasOwn(out, name)) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

export function cookieHeader(name, value, { maxAge, path = "/", secure }) {
  return [
    `${name}=${value}`, `Path=${path}`, `Max-Age=${Math.floor(maxAge / 1000)}`,
    "HttpOnly", "SameSite=Lax", ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
