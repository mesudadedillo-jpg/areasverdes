// Service worker: recibe notificaciones y permite abrir la app sin conexión.
const CACHE = "areaverde-v2";
const ARCHIVOS = ["/", "/index.html", "/app.js", "/styles.css", "/favicon.svg", "/icon-192.png", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

// Primero la red (para tener siempre la versión nueva); si no hay internet, la copia guardada.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        const copia = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copia));
        return r;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("/index.html")))
  );
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { titulo: "Área Verde", cuerpo: e.data?.text() || "" }; }
  e.waitUntil(
    self.registration.showNotification(d.titulo || "Área Verde", {
      body: d.cuerpo || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: d.etiqueta,
      renotify: true,
      vibrate: [200, 100, 200],
      data: { url: d.url || "/#hoy" },
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url || "/#hoy";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((ws) => {
      for (const w of ws) {
        if ("focus" in w) {
          w.navigate?.(url);
          return w.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
