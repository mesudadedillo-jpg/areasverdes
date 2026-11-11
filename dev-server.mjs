// Servidor local para probar sin Netlify:  npm run dev  ->  http://localhost:8888
// Los datos se guardan en la carpeta .data/
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

process.env.AREAS_LOCAL = "1";
const { default: api } = await import("./netlify/functions/api.mjs");

const PORT = Number(process.env.PORT) || 8888;
const PUBLIC = path.resolve("public");
const TIPOS = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname.startsWith("/api/")) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
      });
      const r = await api(request);
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    // /visita sirve visita.html, igual que en Netlify
    const ruta = url.pathname === "/" ? "index.html" : url.pathname === "/encuesta" ? "visita.html" : path.extname(url.pathname) ? url.pathname : url.pathname + ".html";
    let file = path.join(PUBLIC, ruta);
    if (!file.startsWith(PUBLIC)) file = path.join(PUBLIC, "index.html");
    try {
      const data = await fs.readFile(file);
      res.writeHead(200, { "content-type": TIPOS[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("No encontrado");
    }
  })
  .listen(PORT, () => console.log(`Áreas Verdes en http://localhost:${PORT}`));
