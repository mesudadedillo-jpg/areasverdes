// Notificaciones push (Web Push). Las llaves VAPID se crean solas la primera vez.
import webpush from "web-push";
import crypto from "node:crypto";
import * as db from "./store.mjs";

let listo = null;
async function llaves() {
  if (listo) return listo;
  let k = process.env.VAPID_PUBLIC_KEY
    ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY }
    : await db.get("config/vapid");
  if (!k) {
    k = webpush.generateVAPIDKeys();
    await db.set("config/vapid", k);
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:areaverde@upt.edu.mx", k.publicKey, k.privateKey);
  listo = k;
  return k;
}

export async function clavePublica() {
  return (await llaves()).publicKey;
}

const idSub = (endpoint) => crypto.createHash("sha256").update(endpoint).digest("hex").slice(0, 24);

export async function suscribir(usuarioId, sub) {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error("Suscripción no válida");
  await db.set(`push/${usuarioId}/${idSub(sub.endpoint)}`, { endpoint: sub.endpoint, keys: sub.keys, en: Date.now() });
}

export async function desuscribir(usuarioId, endpoint) {
  await db.del(`push/${usuarioId}/${idSub(endpoint)}`);
}

export async function tieneSuscripcion(usuarioId) {
  return (await db.list(`push/${usuarioId}/`)).length > 0;
}

// Envía una notificación a todos los dispositivos de un usuario
export async function enviarA(usuarioId, { titulo, cuerpo, url = "/#hoy", etiqueta }) {
  if (!usuarioId) return 0;
  await llaves();
  const keys = await db.list(`push/${usuarioId}/`);
  let enviados = 0;
  for (const key of keys) {
    const sub = await db.get(key);
    if (!sub) continue;
    try {
      await webpush.sendNotification(sub, JSON.stringify({ titulo, cuerpo, url, etiqueta }), { TTL: 3600 });
      enviados++;
    } catch (e) {
      // 404/410: el dispositivo ya no acepta notificaciones; se borra
      if (e.statusCode === 404 || e.statusCode === 410) await db.del(key);
      else console.error("push", e.statusCode, e.body || e.message);
    }
  }
  return enviados;
}
