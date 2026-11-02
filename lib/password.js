// パスワードの scrypt ハッシュ化と照合
// 形式: scrypt$N$r$p$<salt base64url>$<hash base64url>（base64url なので , : を含まない）
import crypto from "node:crypto";

const PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 32;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LEN, PARAMS);
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64url"), hash.toString("base64url")].join("$");
}

export const isHashed = (stored) => typeof stored === "string" && stored.startsWith("scrypt$");

// 形式が不正なら null
export function parseHash(stored) {
  const [scheme, N, r, p, salt, hash, ...rest] = stored.split("$");
  const n = Number(N), rr = Number(r), pp = Number(p);
  if (scheme !== "scrypt" || rest.length || !salt || !hash) return null;
  // N は 2 のべき乗。設定ミスで極端に重くならないよう上限を設ける
  if (!Number.isInteger(n) || n < 2 || n > 2 ** 20 || (n & (n - 1))) return null;
  if (!Number.isInteger(rr) || rr < 1 || rr > 32 || !Number.isInteger(pp) || pp < 1 || pp > 16) return null;
  const hashBuf = Buffer.from(hash, "base64url");
  if (hashBuf.length < 16) return null;
  return { N: n, r: rr, p: pp, salt: Buffer.from(salt, "base64url"), hash: hashBuf };
}

export function verifyHash(password, parsed) {
  const actual = crypto.scryptSync(password, parsed.salt, parsed.hash.length, {
    N: parsed.N, r: parsed.r, p: parsed.p, maxmem: 256 * parsed.N * parsed.r,
  });
  return crypto.timingSafeEqual(actual, parsed.hash);
}
