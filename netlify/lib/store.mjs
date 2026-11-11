// Capa de almacenamiento.
// En Netlify usa Netlify Blobs (gratis, sin configurar nada).
// En local (AREAS_LOCAL=1) guarda archivos JSON en la carpeta .data/
import { getStore } from "@netlify/blobs";
import fs from "node:fs/promises";
import path from "node:path";

const LOCAL = process.env.AREAS_LOCAL === "1";
const LOCAL_DIR = path.resolve(process.env.AREAS_DATA_DIR || ".data");

let blobStore = null;
function blobs() {
  if (!blobStore) blobStore = getStore({ name: "areasverdes", consistency: "strong" });
  return blobStore;
}

const fileFor = (key) => path.join(LOCAL_DIR, encodeURIComponent(key) + ".json");

export async function get(key, fallback = null) {
  if (LOCAL) {
    try {
      return JSON.parse(await fs.readFile(fileFor(key), "utf8"));
    } catch {
      return fallback;
    }
  }
  const v = await blobs().get(key, { type: "json" });
  return v ?? fallback;
}

export async function set(key, value) {
  if (LOCAL) {
    await fs.mkdir(LOCAL_DIR, { recursive: true });
    // Se escribe a un archivo temporal y luego se renombra, para que nadie lea un archivo a medias
    const tmp = fileFor(key) + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(value));
    await fs.rename(tmp, fileFor(key));
    return;
  }
  await blobs().setJSON(key, value);
}

export async function del(key) {
  if (LOCAL) {
    await fs.rm(fileFor(key), { force: true });
    return;
  }
  await blobs().delete(key);
}

export async function list(prefix) {
  if (LOCAL) {
    let names = [];
    try {
      names = await fs.readdir(LOCAL_DIR);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith(".json"))
      .map((n) => decodeURIComponent(n.slice(0, -5)))
      .filter((k) => k.startsWith(prefix));
  }
  const { blobs: items } = await blobs().list({ prefix });
  return items.map((b) => b.key);
}

// Lee, modifica y guarda un valor sin pisar cambios de otra petición que llegue al mismo tiempo.
// cambiar(valor) modifica el valor y devuelve un resultado; si devuelve false, no se guarda nada.
// En Netlify se guarda solo si nadie lo cambió desde que se leyó (etag); si alguien lo cambió, se vuelve a intentar.
const candados = new Map();
export function actualizar(key, fallback, cambiar) {
  if (!LOCAL) return actualizarRemoto(key, fallback, cambiar);
  // En local (un solo proceso) basta con hacer los cambios de uno en uno
  const previo = candados.get(key) || Promise.resolve();
  const turno = previo.catch(() => {}).then(() => actualizarRemoto(key, fallback, cambiar));
  candados.set(key, turno.catch(() => {}));
  return turno;
}

async function actualizarRemoto(key, fallback, cambiar) {
  for (let intento = 0; intento < 6; intento++) {
    let valor;
    let etag;
    if (LOCAL) {
      valor = await get(key, null);
    } else {
      const r = await blobs().getWithMetadata(key, { type: "json" });
      valor = r?.data ?? null;
      etag = r?.etag;
    }
    if (valor == null) valor = structuredClone(fallback);
    const resultado = await cambiar(valor);
    if (resultado === false) return false;
    if (LOCAL) {
      await set(key, valor);
      return resultado;
    }
    const w = await blobs().setJSON(key, valor, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
    if (w?.modified !== false) return resultado;
    await new Promise((ok) => setTimeout(ok, 40 + Math.random() * 120));
  }
  throw new Error("Hay muchos cambios al mismo tiempo. Intenta de nuevo.");
}

export async function getMany(keys) {
  return Promise.all(keys.map((k) => get(k)));
}
