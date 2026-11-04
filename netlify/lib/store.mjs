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
    await fs.writeFile(fileFor(key), JSON.stringify(value));
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

export async function getMany(keys) {
  return Promise.all(keys.map((k) => get(k)));
}
