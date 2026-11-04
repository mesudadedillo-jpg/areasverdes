// Contraseñas (scrypt) y sesiones con token firmado (HMAC).
import crypto from "node:crypto";
import * as db from "./store.mjs";

const SESSION_HOURS = 24 * 7;

async function secret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  let s = await db.get("config/secret");
  if (!s) {
    s = crypto.randomBytes(32).toString("hex");
    await db.set("config/secret", s);
  }
  return s;
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash };
}

export function checkPassword(password, user) {
  if (!user?.hash || !user?.salt) return false;
  const test = crypto.scryptSync(String(password), user.salt, 64);
  const real = Buffer.from(user.hash, "hex");
  return real.length === test.length && crypto.timingSafeEqual(real, test);
}

const b64 = (s) => Buffer.from(s).toString("base64url");

export async function createToken(user) {
  const payload = b64(JSON.stringify({ uid: user.id, exp: Date.now() + SESSION_HOURS * 3600e3 }));
  const sig = crypto.createHmac("sha256", await secret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export async function readToken(token) {
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", await secret()).update(payload).digest("base64url");
  const a = Buffer.from(sig || "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

// "José Pérez  " -> "jose perez"
export function normalize(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
