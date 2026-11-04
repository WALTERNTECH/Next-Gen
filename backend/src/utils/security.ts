import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

// Passwords (bcrypt), session tokens, AES-256-GCM sealing for sensitive fields and files,
// TOTP for MFA, and signed links to private files.

export const hashPassword = (pw: string) => bcrypt.hash(pw, 11);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);
export const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

export type SessionClaims = { sub: string; tv: number; aud: "user" | "admin"; mfa?: boolean };

/** User sessions last 7 days; admin sessions 12 hours, and only 10 minutes before the authenticator step. */
export function signSession(aud: "user" | "admin", id: string, tv: number, mfa = false): string {
  const expiresIn = aud === "user" ? "7d" : mfa ? "12h" : "10m";
  return jwt.sign({ tv, mfa }, env.jwtSecret, { subject: id, audience: aud, expiresIn });
}
export function verifySession(token: string, aud: "user" | "admin"): SessionClaims | null {
  try {
    return jwt.verify(token, env.jwtSecret, { audience: aud }) as SessionClaims;
  } catch {
    return null;
  }
}

/** Short reference without look-alike characters. */
export function shortRef(prefix: string, len = 6): string {
  const abc = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = prefix;
  for (let i = 0; i < len; i++) s += abc[randomInt(0, abc.length)];
  return s;
}

// ---- AES-256-GCM ---------------------------------------------------------------------------

export function sealBytes(plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", env.masterKey, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), body]);
}
export function openBytes(sealed: Buffer): Buffer {
  if (sealed[0] !== 1) throw new Error("unknown ciphertext version");
  const d = createDecipheriv("aes-256-gcm", env.masterKey, sealed.subarray(1, 13));
  d.setAuthTag(sealed.subarray(13, 29));
  return Buffer.concat([d.update(sealed.subarray(29)), d.final()]);
}
export const encrypt = (plain: string) => `v1.${sealBytes(Buffer.from(plain, "utf8")).toString("base64")}`;
export function decrypt(sealed: string): string {
  if (!sealed.startsWith("v1.")) throw new Error("unknown ciphertext version");
  return openBytes(Buffer.from(sealed.slice(3), "base64")).toString("utf8");
}
export const last4 = (s: string) => s.replace(/\s/g, "").slice(-4);

// ---- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ---------------------------------------------------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function newTotpSecret(): string {
  const bytes = randomBytes(20);
  let bits = "",
    out = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}
function base32Decode(s: string): Buffer {
  let bits = "";
  for (const ch of s.replace(/=+$/, "").toUpperCase()) bits += B32.indexOf(ch).toString(2).padStart(5, "0");
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
export function totpAt(secret: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}
export function verifyTotp(secret: string, code: string, now = Date.now()): boolean {
  const step = Math.floor(now / 30_000);
  const want = Buffer.from(String(code).replace(/\s/g, ""));
  return [-1, 0, 1].some((d) => {
    const got = Buffer.from(totpAt(secret, step + d));
    return got.length === want.length && timingSafeEqual(got, want);
  });
}
export const totpUri = (secret: string, account: string, issuer = "Next-Gen") =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&period=30&digits=6`;

// ---- Signed file links ----------------------------------------------------------------------

/** A link to a private file, valid for at most env.fileLinkTtl seconds (15 minutes). */
export function signFile(id: string, now = Date.now()): { url: string; expires_at: string } {
  const exp = Math.floor(now / 1000) + env.fileLinkTtl;
  const sig = createHmac("sha256", env.fileKey).update(`${id}.${exp}`).digest("base64url");
  return { url: `/api/files/${id}?e=${exp}&s=${sig}`, expires_at: new Date(exp * 1000).toISOString() };
}
export function checkFileSig(id: string, exp: string, sig: string, now = Date.now()): boolean {
  if (!/^\d+$/.test(exp) || Number(exp) * 1000 < now || Number(exp) * 1000 > now + (env.fileLinkTtl + 5) * 1000) return false;
  const want = Buffer.from(createHmac("sha256", env.fileKey).update(`${id}.${exp}`).digest("base64url"));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}
