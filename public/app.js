// Área Verde UPT — interfaz web (sin frameworks)
const $ = (s, el = document) => el.querySelector(s);
const app = $("#app");

const estado = {
  token: leer("av_token"),
  usuario: null,
  vista: null,
  cache: {},
};

function leer(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function guardar(k, v) {
  try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {}
}

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(ruta, { method = "GET", body } = {}) {
  const res = await fetch("/api/" + ruta, {
    method,
    headers: {
      "content-type": "application/json",
      ...(estado.token ? { authorization: "Bearer " + estado.token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 401 && estado.token) {
    cerrarSesion();
    throw new Error(data.error || "Sesión terminada");
  }
  if (!res.ok) throw new Error(data.error || "Algo salió mal (" + res.status + ")");
  return data;
}

// ------------------------------------------------------------ notificaciones e instalación
const esIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const instalada = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const soportaPush = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
let registroSW = null;
let eventoInstalar = null;

if ("serviceWorker" in navigator) {
  registroSW = navigator.serviceWorker.register("/sw.js").catch(() => null);
}
addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  eventoInstalar = e;
  pintarNotif();
});
addEventListener("appinstalled", () => {
  eventoInstalar = null;
  pintarNotif();
});

function b64aBytes(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function suscripcionActual() {
  const reg = await registroSW;
  return reg ? reg.pushManager.getSubscription() : null;
}

// 'activas' | 'pendiente' | 'bloqueadas' | 'ios-instalar' | 'no-soporta'
async function estadoNotif() {
  if (esIOS && !instalada()) return "ios-instalar";
  if (!soportaPush()) return "no-soporta";
  if (Notification.permission === "denied") return "bloqueadas";
  if (Notification.permission === "granted") {
    const sub = await suscripcionActual();
    if (sub) {
      // Se vuelve a registrar en el servidor por si cambió de usuario o se borró
      api("push/suscribir", { method: "POST", body: { suscripcion: sub.toJSON() } }).catch(() => {});
      return "activas";
    }
  }
  return "pendiente";
}

async function activarNotif() {
  if (!soportaPush()) throw new Error("Este navegador no permite notificaciones.");
  const permiso = await Notification.requestPermission();
  if (permiso !== "granted") {
    pintarNotif();
    throw new Error("No se activaron las notificaciones.");
  }
  const reg = (await registroSW) || (await navigator.serviceWorker.ready);
  const { clave } = await api("push/clave");
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64aBytes(clave) });
  await api("push/suscribir", { method: "POST", body: { suscripcion: sub.toJSON() } });
  await api("push/prueba", { method: "POST" });
  avisar("¡Listo! Te avisaremos cuando te toque regar.");
  pintarNotif();
}

async function desactivarNotif() {
  const sub = await suscripcionActual();
  if (sub) {
    await api("push/quitar", { method: "POST", body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  }
}

const TEXTO_NOTIF = {
  pendiente: {
    t: "Activa las notificaciones",
    d: "Así te avisamos cuando te toque regar y antes de que se acabe tu turno.",
    b: '<button class="btn chico" data-accion="activar-notif">Activar</button>',
  },
  bloqueadas: {
    t: "Las notificaciones están bloqueadas",
    d: "Actívalas en los ajustes del navegador: toca el candado junto a la dirección → Notificaciones → Permitir. Después recarga la página.",
    b: "",
  },
  "ios-instalar": {
    t: "Instala la app para recibir avisos",
    d: "En iPhone: toca Compartir <b>⬆︎</b> → <b>Agregar a pantalla de inicio</b>, y abre la app desde el ícono. Ahí podrás activar las notificaciones.",
    b: "",
  },
  "no-soporta": {
    t: "Tu navegador no admite notificaciones",
    d: "Abre la app en Chrome (Android) o instálala en la pantalla de inicio (iPhone) para recibir avisos.",
    b: "",
  },
};

async function pintarNotif() {
  const caja = $("#notif");
  if (!estado.usuario) {
    caja.hidden = true;
    return;
  }
  const e = await estadoNotif();
  const instalarBtn = eventoInstalar && !instalada() ? '<button class="btn chico sec" data-accion="instalar">Instalar app</button>' : "";
  if (e === "activas" && !instalarBtn) {
    caja.hidden = true;
    return;
  }
  const t = TEXTO_NOTIF[e];
  caja.hidden = false;
  caja.innerHTML = t
    ? `<div class="banner-notif"><div><b>${t.t}</b><span>${t.d}</span></div><div class="fila">${t.b}${instalarBtn}</div></div>`
    : `<div class="banner-notif"><div><b>Instala la app</b><span>Ábrela como aplicación desde tu pantalla de inicio.</span></div><div class="fila">${instalarBtn}</div></div>`;
  // Cada vez que se abre la app sin notificaciones, se vuelve a pedir (una vez por sesión)
  let pedido = null;
  try { pedido = sessionStorage.getItem("av_pedido"); } catch {}
  if (e === "pendiente" && !pedido && !$("#modal").open) {
    try { sessionStorage.setItem("av_pedido", "1"); } catch {}
    abrirModal(
      `<h2>¿Te avisamos cuando te toque regar? 🌱</h2>
       <p>Activa las notificaciones para recibir un aviso cuando tengas turno, un recordatorio una hora antes del límite y un aviso si el turno queda sin registrar.</p>
       <p class="suave">Puedes desactivarlas cuando quieras en <b>Mi cuenta</b>.</p>`,
      async () => {
        await activarNotif();
      }
    );
    $("#modal-form button[value=ok]").textContent = "Activar notificaciones";
    $("#modal-form button[value=cancelar]").textContent = "Ahora no";
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") pintarNotif();
});

function avisar(msg, error = false) {
  const el = $("#aviso");
  el.textContent = msg;
  el.className = "aviso ver" + (error ? " error" : "");
  clearTimeout(avisar.t);
  avisar.t = setTimeout(() => (el.className = "aviso"), 3200);
}

// ------------------------------------------------------------ utilidades de formato
const DIAS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const DIAS_LARGOS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
function fechaBonita(f, largo = false) {
  const d = new Date(f + "T12:00:00");
  return largo
    ? `${DIAS_LARGOS[d.getDay()]} ${d.getDate()} de ${MESES[d.getMonth()]}`
    : `${DIAS[d.getDay()]} ${d.getDate()} ${MESES[d.getMonth()]}`;
}
const ETIQUETA = {
  hecha: "Hecha", pendiente: "Pendiente", incumplida: "No cumplida", lluvia: "Cubierta por lluvia", justificada: "Justificada",
};
const chip = (e) => `<span class="chip ${esc(e)}">${ETIQUETA[e] || esc(e)}</span>`;
const ROL = { superadmin: "Super admin", admin: "Administrador", encargado: "Encargado", estudiante: "Estudiante" };

const ICONOS = {
  sol: `<svg class="icono" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="12" fill="#f5b82e"/><g stroke="#f5b82e" stroke-width="4" stroke-linecap="round"><path d="M32 6v8M32 50v8M6 32h8M50 32h8M13.6 13.6l5.7 5.7M44.7 44.7l5.7 5.7M13.6 50.4l5.7-5.7M44.7 19.3l5.7-5.7"/></g></svg>`,
  nube: `<svg class="icono" viewBox="0 0 64 64" aria-hidden="true"><circle cx="24" cy="24" r="9" fill="#f5b82e"/><path d="M20 48h26a10 10 0 0 0 0-20 14 14 0 0 0-27 4 8 8 0 0 0 1 16z" fill="#b9c7d6"/></svg>`,
  lluvia: `<svg class="icono" viewBox="0 0 64 64" aria-hidden="true"><path d="M18 38h28a10 10 0 0 0 0-20 14 14 0 0 0-27 4 8 8 0 0 0-1 16z" fill="#9fb3c8"/><g stroke="#2563a8" stroke-width="4" stroke-linecap="round"><path d="M22 46l-3 8M34 46l-3 8M46 46l-3 8"/></g></svg>`,
};
const iconoClima = (c) => (c >= 51 ? ICONOS.lluvia : c >= 2 ? ICONOS.nube : ICONOS.sol);
const DECISION_TITULO = {
  lluvia: "Hoy no se riega",
  seco: "Día seco: riego reforzado",
  normal: "Riego normal",
};

// ------------------------------------------------------------ modal
function abrirModal(html, alEnviar) {
  const dlg = $("#modal");
  const form = $("#modal-form");
  form.innerHTML = html + `<div class="modal-acciones"><button class="btn sec" value="cancelar" formnovalidate>Cancelar</button><button class="btn" value="ok">Guardar</button></div>`;
  form.onsubmit = async (ev) => {
    if (ev.submitter?.value === "cancelar") return;
    ev.preventDefault();
    const btn = ev.submitter;
    btn.disabled = true;
    try {
      const datos = Object.fromEntries(new FormData(form));
      const r = await alEnviar(datos, form);
      if (r !== false) dlg.close();
    } catch (e) {
      avisar(e.message, true);
    } finally {
      btn.disabled = false;
    }
  };
  dlg.showModal();
  setTimeout(() => form.querySelector("input,select,textarea")?.focus(), 30);
}

function confirmar(texto, accion, etiqueta = "Confirmar") {
  abrirModal(`<h2>¿Seguro?</h2><p>${texto}</p>`, accion);
  $("#modal-form button[value=ok]").textContent = etiqueta;
}

// ------------------------------------------------------------ sesión
function cerrarSesion() {
  // Al salir, este dispositivo deja de recibir los avisos de esa cuenta
  if (estado.token) desactivarNotif().catch(() => {});
  estado.token = null;
  estado.usuario = null;
  guardar("av_token", null);
  try { sessionStorage.removeItem("av_pedido"); } catch {}
  $("#notif").hidden = true;
  iniciar();
}

const PESTANAS = {
  estudiante: [["hoy", "Mis tareas"], ["historial", "Historial"], ["sanciones", "Mis sanciones"], ["cuenta", "Mi cuenta"]],
  encargado: [["hoy", "Hoy"], ["plantas", "Zonas y plantas"], ["usuarios", "Estudiantes"], ["historial", "Historial"], ["ajustes", "Clima y horarios"], ["cuenta", "Mi cuenta"]],
  admin: [["panel", "Panel"], ["hoy", "Hoy"], ["plantas", "Zonas y plantas"], ["usuarios", "Usuarios"], ["sanciones", "Sanciones"], ["historial", "Historial"], ["ajustes", "Clima y horarios"], ["cuenta", "Mi cuenta"]],
};
PESTANAS.superadmin = PESTANAS.admin;

function pintarBarra() {
  const u = estado.usuario;
  $("#barra").hidden = !u;
  $("#pestanas").hidden = !u;
  if (!u) return;
  $("#quien-nombre").textContent = u.nombre;
  $("#quien-rol").textContent = ROL[u.rol];
  $("#pestanas").innerHTML = PESTANAS[u.rol]
    .map(([id, t]) => `<button data-ir="${id}" ${estado.vista === id ? 'aria-current="page"' : ""}>${t}</button>`)
    .join("");
}

function ir(vista, extra = {}) {
  estado.vista = vista;
  estado.extra = extra;
  try { history.replaceState(null, "", "#" + vista); } catch {}
  pintarBarra();
  const fn = VISTAS[vista] || VISTAS.hoy;
  app.innerHTML = `<p class="cargando">Cargando…</p>`;
  fn().catch((e) => (app.innerHTML = `<div class="tarjeta"><p>${esc(e.message)}</p></div>`));
}

async function iniciar() {
  pintarBarra();
  if (!estado.token) {
    const { configurado } = await api("estado");
    return configurado ? vistaLogin() : vistaConfigurar();
  }
  try {
    const { usuario } = await api("yo");
    estado.usuario = usuario;
    const pedida = location.hash.slice(1);
    const validas = PESTANAS[usuario.rol].map((p) => p[0]);
    ir(validas.includes(pedida) ? pedida : validas[0]);
    pintarNotif().catch(() => {});
  } catch {
    cerrarSesion();
  }
}

// ------------------------------------------------------------ acceso
function vistaLogin() {
  app.innerHTML = `
  <div class="acceso">
    <div class="logo"><img src="favicon.svg" width="64" height="64" alt="" /></div>
    <h1>Área Verde UPT</h1>
    <p class="sub">Mantenimiento y riego del área verde</p>
    <form class="tarjeta" id="f-login">
      <div class="campo"><label for="usuario">Usuario</label>
        <input id="usuario" name="usuario" autocomplete="username" required placeholder="Tu nombre completo o tu matrícula" /></div>
      <div class="campo"><label for="password">Contraseña</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
        <p class="ayuda">La primera vez tu contraseña es tu matrícula. Después puedes cambiarla.</p></div>
      <button class="btn bloque">Entrar</button>
    </form>
  </div>`;
  $("#f-login").onsubmit = async (ev) => {
    ev.preventDefault();
    const datos = Object.fromEntries(new FormData(ev.target));
    try {
      const r = await api("login", { method: "POST", body: datos });
      estado.token = r.token;
      guardar("av_token", r.token);
      iniciar();
    } catch (e) {
      avisar(e.message, true);
    }
  };
}

function vistaConfigurar() {
  app.innerHTML = `
  <div class="acceso">
    <div class="logo"><img src="favicon.svg" width="64" height="64" alt="" /></div>
    <h1>Configuración inicial</h1>
    <p class="sub">Crea la cuenta del administrador (jefe de grupo o tutor). Solo se hace una vez.</p>
    <form class="tarjeta" id="f-conf">
      <div class="campo"><label>Nombre completo</label><input name="nombre" required /></div>
      <div class="campo"><label>Matrícula o número de empleado (opcional)</label><input name="matricula" /></div>
      <div class="campo"><label>Contraseña</label><input name="password" type="password" minlength="6" required autocomplete="new-password" />
        <p class="ayuda">Mínimo 6 caracteres.</p></div>
      <button class="btn bloque">Crear administrador</button>
    </form>
  </div>`;
  $("#f-conf").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const r = await api("configurar", { method: "POST", body: Object.fromEntries(new FormData(ev.target)) });
      estado.token = r.token;
      guardar("av_token", r.token);
      avisar("Listo. Ahora registra las zonas, las plantas y a los estudiantes.");
      iniciar();
    } catch (e) {
      avisar(e.message, true);
    }
  };
}

// ------------------------------------------------------------ componentes
function tarjetaClima(c) {
  if (!c.disponible) {
    return `<section class="tarjeta"><h2>Clima</h2><p class="suave">No se pudo consultar el clima en este momento. ${esc(c.decision?.motivo || "")}</p></section>`;
  }
  const d = c.decision;
  return `
  <section class="tarjeta">
    <div class="entre"><h2>Clima en ${esc(c.lugar)}</h2><small>${c.hoy ? fechaBonita(c.hoy.fecha, true) : ""}</small></div>
    <div class="clima">
      ${iconoClima(c.actual?.codigo ?? c.hoy?.codigo)}
      <div>
        <div class="temp">${c.actual ? Math.round(c.actual.temp) + " °C" : "—"}</div>
        <div class="suave">${esc(c.actual?.descripcion || c.hoy?.descripcion)} · Máx ${Math.round(c.hoy.max)}° / Mín ${Math.round(c.hoy.min)}° · Lluvia hoy ${c.hoy.lluviaMm} mm${c.hoy.probLluvia != null ? ` (${c.hoy.probLluvia}%)` : ""}${c.actual?.humedad != null ? ` · Humedad ${c.actual.humedad}%` : ""}</div>
      </div>
    </div>
    <div class="decision ${esc(d.tipo)}"><div><strong>${DECISION_TITULO[d.tipo]}</strong><span>${esc(d.motivo)}</span></div></div>
    <div class="proximos">${(c.proximos || [])
      .map((p) => `<div><b>${fechaBonita(p.fecha).split(" ")[0]}</b><br>${Math.round(p.max)}° / ${Math.round(p.min)}°<br><small>${p.lluviaMm} mm</small></div>`)
      .join("")}</div>
  </section>`;
}

function filaTarea(t, { staff = false, verFecha = false } = {}) {
  const e = t.estadoReal;
  const j = t.justificacion;
  const acciones = [];
  if (!staff && e === "pendiente") acciones.push(`<button class="btn chico" data-accion="hecha" data-id="${t.fecha}_${t.id}">Ya regué</button>`);
  if (!staff && (e === "pendiente" || e === "incumplida") && !j)
    acciones.push(`<button class="btn chico sec" data-accion="justificar" data-id="${t.fecha}_${t.id}">Justificar</button>`);
  if (staff && e === "pendiente") {
    acciones.push(`<button class="btn chico sec" data-accion="hecha" data-id="${t.fecha}_${t.id}" title="Registrar que sí se regó">Marcar hecha</button>`);
    acciones.push(`<button class="btn chico sec" data-accion="reasignar" data-id="${t.fecha}_${t.id}">Reasignar</button>`);
  }
  const just = j
    ? `<div class="meta">Justificación: “${esc(j.motivo)}” — ${j.estado === "pendiente" ? "en revisión" : j.estado}${j.respuesta ? ` (${esc(j.respuesta)})` : ""}</div>`
    : "";
  return `
  <div class="tarea">
    <div>
      <div class="titulo">${esc(t.plantaNombre)} <small>· ${esc(t.areaNombre)}</small></div>
      <div class="meta">${verFecha ? fechaBonita(t.fecha) + " · " : ""}Turno de ${esc(t.turno)} · antes de las ${esc(t.limite)}${t.litros ? ` · ~${t.litros} L` : ""}${staff ? ` · <b>${esc(t.estudianteNombre)}</b>` : ""}${t.estado === "hecha" ? ` · registrado ${esc(t.horaHecha || "")}${t.hechaPor && t.hechaPor !== t.estudianteNombre ? " por " + esc(t.hechaPor) : ""}` : ""}</div>
      ${just}
    </div>
    <div class="acciones">${chip(e)}${acciones.join("")}</div>
  </div>`;
}

// ------------------------------------------------------------ vistas
const VISTAS = {};

VISTAS.hoy = async () => {
  const staff = estado.usuario.rol !== "estudiante";
  const [hoy, clima] = await Promise.all([api("hoy"), api("clima")]);
  estado.cache.hoy = hoy;
  const { dia, tareas, resumen } = hoy;
  const u = estado.usuario;
  let aviso = "";
  if (u.debeCambiar) aviso = `<div class="banner aviso-ambar">Todavía usas tu contraseña inicial. <a href="#cuenta" data-ir="cuenta">Cámbiala aquí</a> para proteger tu cuenta.</div>`;

  let cuerpo;
  if (dia?.inactivo) cuerpo = `<p class="vacio">${esc(dia.motivo)}</p>`;
  else if (!tareas.length)
    cuerpo = `<p class="vacio">${
      dia?.decision?.tipo === "lluvia"
        ? "Hoy no hay riegos: la lluvia se encarga."
        : staff
        ? "No hay turnos hoy. Revisa que existan plantas y estudiantes registrados, o vuelve a generar los turnos."
        : "Hoy no tienes turnos asignados. ¡Gracias por cuidar el área verde!"
    }</p>`;
  else cuerpo = tareas.map((t) => filaTarea(t, { staff })).join("");

  const statsHtml = staff
    ? `<div class="stats">
        <div class="stat"><b>${resumen.total}</b><small>Turnos de hoy</small></div>
        <div class="stat"><b>${resumen.hechas}</b><small>Hechos</small></div>
        <div class="stat"><b>${resumen.pendientes}</b><small>Pendientes</small></div>
        <div class="stat"><b>${resumen.incumplidas}</b><small>No cumplidos</small></div>
      </div>`
    : "";

  const herramientas = staff
    ? `<div class="fila">
        <button class="btn sec chico" data-accion="lluvia">Registrar que llovió</button>
        <button class="btn sec chico" data-accion="regenerar">Volver a generar turnos</button>
      </div>`
    : "";

  app.innerHTML = `
    ${aviso}
    <h1>${staff ? "Turnos de hoy" : "Hola, " + esc(u.nombre.split(" ")[0])}</h1>
    <p class="suave">${fechaBonita(hoy.ahora.fecha, true)}${!staff && resumen.total ? ` · El grupo lleva ${resumen.hechas} de ${resumen.total} riegos de hoy` : ""}</p>
    ${tarjetaClima(clima)}
    ${statsHtml}
    <section class="tarjeta">
      <div class="entre"><h2>${staff ? "Todos los turnos" : "Tus tareas de hoy"}</h2>${herramientas}</div>
      ${cuerpo}
    </section>`;
};

VISTAS.historial = async () => {
  const staff = estado.usuario.rol !== "estudiante";
  const filtro = estado.extra?.estudiante || "";
  const [{ tareas }, usuariosR] = await Promise.all([
    api("tareas" + (filtro ? "?estudiante=" + encodeURIComponent(filtro) : "")),
    staff ? api("usuarios") : Promise.resolve({ usuarios: [] }),
  ]);
  const estudiantes = usuariosR.usuarios.filter((x) => x.rol === "estudiante");
  const filas = tareas;
  app.innerHTML = `
    <h1>Historial</h1>
    <p class="suave">Últimos 30 días.</p>
    ${staff ? `<div class="tarjeta"><label for="filtro-est">Ver estudiante</label>
      <select id="filtro-est"><option value="">Todos</option>${estudiantes
        .map((e) => `<option value="${e.id}" ${e.id === filtro ? "selected" : ""}>${esc(e.nombre)}</option>`)
        .join("")}</select></div>` : ""}
    <section class="tarjeta">${filas.length ? filas.map((t) => filaTarea(t, { staff, verFecha: true })).join("") : `<p class="vacio">Sin registros todavía.</p>`}</section>`;
  const sel = $("#filtro-est");
  if (sel) sel.onchange = () => ir("historial", { estudiante: sel.value });
};

VISTAS.sanciones = async () => {
  if (estado.usuario.rol === "estudiante") {
    const { sanciones } = await api("sanciones");
    app.innerHTML = `
      <h1>Mis sanciones</h1>
      <p class="suave">Solo tú y el administrador pueden ver esta información.</p>
      <section class="tarjeta">${
        sanciones.length
          ? sanciones
              .map(
                (s) => `<div class="tarea"><div><div class="titulo">${esc(s.nombre)}</div>
                <div class="meta">${fechaBonita(s.fecha)} · ${esc(s.descripcion)}${s.nota ? ` · Nota: ${esc(s.nota)}` : ""}</div></div>
                <div class="acciones"><span class="chip ${s.estado === "cumplida" ? "hecha" : "pendiente"}">${s.estado === "cumplida" ? "Cumplida" : "Por cumplir"}</span></div></div>`
              )
              .join("")
          : `<p class="vacio">No tienes sanciones. ¡Sigue así!</p>`
      }</section>`;
    return;
  }
  const [{ catalogo }, { sanciones }] = await Promise.all([api("sanciones/catalogo"), api("sanciones")]);
  app.innerHTML = `
    <h1>Sanciones</h1>
    <p class="suave">Las sanciones son formativas y proporcionales. El catálogo debe acordarse con el grupo antes de usarse.</p>
    <section class="tarjeta">
      <div class="entre"><h2>Catálogo (de menor a mayor)</h2><button class="btn chico" data-accion="nueva-sancion">Agregar</button></div>
      ${catalogo
        .sort((a, b) => a.nivel - b.nivel)
        .map(
          (c) => `<div class="tarea"><div><div class="titulo">${esc(c.nombre)}</div><div class="meta">${esc(c.descripcion)}</div></div>
          <div class="acciones"><button class="btn chico sec" data-accion="borrar-cat" data-id="${c.id}">Quitar</button></div></div>`
        )
        .join("")}
    </section>
    <section class="tarjeta">
      <h2>Sanciones aplicadas</h2>
      ${
        sanciones.length
          ? sanciones
              .map(
                (s) => `<div class="tarea"><div><div class="titulo">${esc(s.estudianteNombre)} — ${esc(s.nombre)}</div>
            <div class="meta">${fechaBonita(s.fecha)} · Asignada por ${esc(s.asignadaPor)}${s.tareaIds?.length ? ` · ${s.tareaIds.length} turno(s) no cumplido(s)` : ""}${s.nota ? ` · ${esc(s.nota)}` : ""}</div></div>
            <div class="acciones"><span class="chip ${s.estado === "cumplida" ? "hecha" : "pendiente"}">${s.estado === "cumplida" ? "Cumplida" : "Por cumplir"}</span>
            ${s.estado !== "cumplida" ? `<button class="btn chico sec" data-accion="sancion-cumplida" data-id="${s.id}">Marcar cumplida</button>` : ""}
            <button class="btn chico sec" data-accion="borrar-sancion" data-id="${s.id}">Eliminar</button></div></div>`
              )
              .join("")
          : `<p class="vacio">Aún no se ha aplicado ninguna sanción.</p>`
      }
    </section>`;
};

VISTAS.panel = async () => {
  const [r, cat] = await Promise.all([api("admin/resumen?dias=30"), api("sanciones/catalogo")]);
  estado.cache.resumen = r;
  estado.cache.catalogo = cat.catalogo;
  const totalAsig = r.estudiantes.reduce((s, e) => s + e.asignadas, 0);
  const totalHechas = r.estudiantes.reduce((s, e) => s + e.hechas, 0);
  const totalInc = r.estudiantes.reduce((s, e) => s + e.incumplidas, 0);
  app.innerHTML = `
    <h1>Panel del administrador</h1>
    <p class="suave">Últimos ${r.dias} días. Esta información es privada: solo la ve el administrador.</p>
    <div class="stats">
      <div class="stat"><b>${r.estudiantes.filter((e) => e.activo).length}</b><small>Estudiantes activos</small></div>
      <div class="stat"><b>${totalAsig}</b><small>Turnos asignados</small></div>
      <div class="stat"><b>${totalHechas}</b><small>Turnos cumplidos</small></div>
      <div class="stat"><b>${totalInc}</b><small>No cumplidos</small></div>
      <div class="stat"><b>${r.justificacionesPendientes.length}</b><small>Justificaciones por revisar</small></div>
    </div>

    <section class="tarjeta">
      <h2>Justificaciones por revisar</h2>
      ${
        r.justificacionesPendientes.length
          ? r.justificacionesPendientes
              .map(
                (t) => `<div class="tarea"><div><div class="titulo">${esc(t.estudianteNombre)} · ${esc(t.plantaNombre)}</div>
            <div class="meta">${fechaBonita(t.fecha)} · turno de ${esc(t.turno)}</div><div class="meta">“${esc(t.justificacion.motivo)}”</div></div>
            <div class="acciones"><button class="btn chico" data-accion="resolver" data-ok="1" data-id="${t.fecha}_${t.id}">Aceptar</button>
            <button class="btn chico sec" data-accion="resolver" data-ok="0" data-id="${t.fecha}_${t.id}">Rechazar</button></div></div>`
              )
              .join("")
          : `<p class="vacio">No hay justificaciones pendientes.</p>`
      }
    </section>

    <section class="tarjeta">
      <h2>Turnos no cumplidos sin sanción</h2>
      ${
        r.incumplidas.length
          ? r.incumplidas
              .map(
                (t) => `<div class="tarea"><div><div class="titulo">${esc(t.estudianteNombre)} · ${esc(t.plantaNombre)}</div>
            <div class="meta">${fechaBonita(t.fecha)} · turno de ${esc(t.turno)} · ${t.justificacion?.estado === "rechazada" ? "justificación rechazada" : "sin justificación"}</div></div>
            <div class="acciones"><button class="btn chico peligro" data-accion="sancionar" data-est="${t.estudianteId}" data-tarea="${t.fecha}_${t.id}">Aplicar sanción</button></div></div>`
              )
              .join("")
          : `<p class="vacio">Todos han cumplido o ya fueron atendidos.</p>`
      }
    </section>

    <section class="tarjeta">
      <h2>Cumplimiento por estudiante</h2>
      <div class="tabla-env"><table>
        <thead><tr><th>Estudiante</th><th class="num">Asignados</th><th class="num">Hechos</th><th class="num">No cumplidos</th><th class="num">Justificados</th><th>Cumplimiento</th><th class="num">Sanciones</th><th></th></tr></thead>
        <tbody>${
          r.estudiantes
            .map(
              (e) => `<tr>
          <td>${esc(e.nombre)}${e.activo ? "" : ' <span class="chip info">inactivo</span>'}<br><small>${esc(e.matricula)}</small></td>
          <td class="num">${e.asignadas}</td><td class="num">${e.hechas}</td>
          <td class="num">${e.incumplidas ? `<span class="chip incumplida">${e.incumplidas}</span>` : 0}</td>
          <td class="num">${e.justificadas}</td>
          <td>${e.cumplimiento == null ? "<small>—</small>" : `${e.cumplimiento}%<div class="barra-mini"><i style="width:${e.cumplimiento}%"></i></div>`}</td>
          <td class="num">${e.sancionesActivas}</td>
          <td><button class="btn chico sec" data-accion="sancionar" data-est="${e.id}">Sancionar</button></td>
        </tr>`
            )
            .join("") || `<tr><td colspan="8" class="vacio">Aún no hay estudiantes.</td></tr>`
        }</tbody>
      </table></div>
    </section>`;
};

const PRESETS = [
  ["", "Elegir un tipo (opcional)…"],
  ["arbol-joven", "Árbol recién plantado", 2, 1, 15],
  ["arbol", "Árbol establecido", 7, 1, 30],
  ["arbusto", "Arbusto", 3, 1, 6],
  ["flores", "Flores de temporada", 1, 2, 2],
  ["hierbas", "Hierbas aromáticas", 2, 1, 1],
  ["suculenta", "Cactus o suculenta", 10, 0, 1],
  ["pasto", "Pasto", 2, 1, 5],
];

function formPlanta(p = {}, areas) {
  return `
    <h2>${p.id ? "Editar planta" : "Nueva planta o árbol"}</h2>
    ${p.id ? "" : `<div class="campo"><label>Tipo de planta</label><select name="_preset" id="preset">${PRESETS.map((x) => `<option value="${x[0]}">${x[1]}</option>`).join("")}</select>
      <p class="ayuda">Rellena valores orientativos. Ajústalos con la información real de cada especie.</p></div>`}
    <div class="campos">
      <div class="campo"><label>Nombre</label><input name="nombre" required value="${esc(p.nombre)}" placeholder="Ej. Fresno 1" /></div>
      <div class="campo"><label>Especie</label><input name="especie" value="${esc(p.especie)}" placeholder="Ej. Fresno" /></div>
    </div>
    <div class="campo"><label>Zona</label><select name="areaId">${areas.map((a) => `<option value="${a.id}" ${a.id === p.areaId ? "selected" : ""}>${esc(a.nombre)}</option>`).join("") || '<option value="">Sin zonas registradas</option>'}</select></div>
    <div class="campos">
      <div class="campo"><label>Regar cada (días)</label><input name="cadaDias" type="number" min="1" max="30" required value="${esc(p.cadaDias ?? 1)}" />
        <p class="ayuda">Con clima normal. 1 = diario.</p></div>
      <div class="campo"><label>Veces al día si está seco</label><select name="vecesSeco">
        ${[0, 1, 2].map((v) => `<option value="${v}" ${Number(p.vecesSeco ?? 0) === v ? "selected" : ""}>${v === 0 ? "Igual que siempre" : v === 1 ? "1 vez (diario)" : "2 veces (mañana y tarde)"}</option>`).join("")}
      </select><p class="ayuda">En días calurosos sin lluvia.</p></div>
      <div class="campo"><label>Litros por riego</label><input name="litros" type="number" min="0" step="0.5" value="${esc(p.litros ?? "")}" /></div>
      <div class="campo"><label>Sol</label><select name="sol">${["", "Pleno sol", "Media sombra", "Sombra"].map((s) => `<option ${s === p.sol ? "selected" : ""}>${s}</option>`).join("")}</select></div>
    </div>
    <div class="campo"><label>Cuidados y requisitos</label><textarea name="cuidados" placeholder="Ej. No encharcar. Podar en primavera.">${esc(p.cuidados)}</textarea></div>`;
}

VISTAS.plantas = async () => {
  const [{ areas }, { plantas }] = await Promise.all([api("areas"), api("plantas")]);
  estado.cache.areas = areas;
  estado.cache.plantas = plantas;
  const porZona = (id) => plantas.filter((p) => (p.areaId || "") === id);
  const sinZona = plantas.filter((p) => !areas.some((a) => a.id === p.areaId));
  const tablaPlantas = (lista) =>
    lista.length
      ? `<div class="tabla-env"><table><thead><tr><th>Planta</th><th>Riego normal</th><th>Si está seco</th><th>Último riego</th><th></th></tr></thead><tbody>${lista
          .map(
            (p) => `<tr><td><b>${esc(p.nombre)}</b>${p.especie ? `<br><small>${esc(p.especie)}</small>` : ""}${p.cuidados ? `<br><small>${esc(p.cuidados)}</small>` : ""}</td>
          <td>${p.cadaDias === 1 ? "Diario" : `Cada ${p.cadaDias} días`}${p.litros ? `<br><small>~${p.litros} L</small>` : ""}</td>
          <td>${p.vecesSeco === 2 ? "2 veces al día" : p.vecesSeco === 1 ? "Diario" : "Igual"}</td>
          <td>${p.ultimoRiego ? fechaBonita(p.ultimoRiego) : "<small>Nunca</small>"}</td>
          <td><div class="fila"><button class="btn chico sec" data-accion="editar-planta" data-id="${p.id}">Editar</button><button class="btn chico sec" data-accion="borrar-planta" data-id="${p.id}">Eliminar</button></div></td></tr>`
          )
          .join("")}</tbody></table></div>`
      : `<p class="vacio">Sin plantas en esta zona.</p>`;

  app.innerHTML = `
    <div class="entre"><h1>Zonas y plantas</h1>
      <div class="fila"><button class="btn sec" data-accion="nueva-zona">Nueva zona</button><button class="btn sec" data-accion="importar-plantas">Importar lista</button><button class="btn" data-accion="nueva-planta">Nueva planta</button></div></div>
    <p class="suave">${areas.length} zona(s) · ${plantas.length} planta(s). Los requisitos de cada planta deciden cuándo y cuántas veces se riega.</p>
    ${areas
      .map(
        (a) => `<section class="tarjeta"><div class="entre"><div><h2>${esc(a.nombre)}</h2>${a.descripcion ? `<small>${esc(a.descripcion)}</small>` : ""}</div>
        <div class="fila"><button class="btn chico sec" data-accion="editar-zona" data-id="${a.id}">Editar</button><button class="btn chico sec" data-accion="borrar-zona" data-id="${a.id}">Eliminar</button></div></div>
        ${tablaPlantas(porZona(a.id))}</section>`
      )
      .join("")}
    ${sinZona.length ? `<section class="tarjeta"><h2>Sin zona</h2>${tablaPlantas(sinZona)}</section>` : ""}
    ${!areas.length && !plantas.length ? `<section class="tarjeta"><p class="vacio">Empieza creando las zonas del área verde (por ejemplo “Zona norte”) y después agrega sus árboles y plantas.</p></section>` : ""}`;
};

VISTAS.usuarios = async () => {
  const admin = esAdmin();
  const sup = estado.usuario.rol === "superadmin";
  const { usuarios, asignables } = await api("usuarios");
  estado.cache.usuarios = usuarios;
  estado.cache.asignables = asignables;
  const orden = { superadmin: 0, admin: 1, encargado: 2, estudiante: 3 };
  usuarios.sort((a, b) => orden[a.rol] - orden[b.rol] || a.nombre.localeCompare(b.nombre, "es"));
  const fila = (u) => {
    const yo = u.id === estado.usuario.id;
    const acciones = [];
    if (yo) acciones.push("<small>Tú</small>");
    else if (puedeTocar(u)) {
      acciones.push(`<button class="btn chico sec" data-accion="editar-usuario" data-id="${u.id}">Editar</button>`);
      acciones.push(`<button class="btn chico sec" data-accion="restablecer" data-id="${u.id}">Restablecer contraseña</button>`);
      if (sup && (u.rol === "admin" || u.rol === "superadmin"))
        acciones.push(`<button class="btn chico peligro" data-accion="quitar-admin" data-id="${u.id}">Quitar ${u.rol === "superadmin" ? "super admin" : "admin"}</button>`);
      acciones.push(`<button class="btn chico sec" data-accion="activar" data-id="${u.id}">${u.activo === false ? "Activar" : "Desactivar"}</button>`);
    } else acciones.push("<small>Solo el super admin puede modificarlo</small>");
    if (u.rol === "estudiante") acciones.push(`<button class="btn chico sec" data-ir="historial" data-est="${u.id}">Historial</button>`);
    return `<tr><td><b>${esc(u.nombre)}</b>${u.debeCambiar ? "<br><small>Aún usa su contraseña inicial</small>" : ""}</td><td>${esc(u.matricula) || "<small>—</small>"}</td>
      ${admin ? `<td>${ROL[u.rol]}</td>` : ""}<td>${u.activo === false ? '<span class="chip info">Inactivo</span>' : '<span class="chip hecha">Activo</span>'}</td>
      <td><div class="fila">${acciones.join("")}</div></td></tr>`;
  };
  const tabla = (titulo, lista, nota = "") =>
    lista.length
      ? `<section class="tarjeta"><h2>${titulo} <small>(${lista.length})</small></h2>${nota}<div class="tabla-env"><table>
        <thead><tr><th>Nombre</th><th>Matrícula</th>${admin ? "<th>Perfil</th>" : ""}<th>Estado</th><th></th></tr></thead>
        <tbody>${lista.map(fila).join("")}</tbody></table></div></section>`
      : "";
  const admins = usuarios.filter((u) => u.rol === "admin" || u.rol === "superadmin");
  app.innerHTML = `
    <div class="entre"><h1>${admin ? "Usuarios" : "Estudiantes"}</h1>
      <div class="fila">
        <button class="btn sec" data-accion="importar-est">Importar estudiantes</button>
        ${asignables.includes("admin") ? `<button class="btn sec" data-accion="nuevo-usuario" data-rol="admin">Agregar admin</button>` : ""}
        <button class="btn" data-accion="nuevo-usuario">Agregar</button>
      </div></div>
    <p class="suave">Usuario: nombre completo o matrícula. Contraseña inicial: la matrícula.</p>
    ${admin ? tabla("Administradores", admins, `<p class="suave">${sup ? "Como super admin puedes agregar, quitar o cambiar a cualquier administrador." : "Puedes agregar administradores; solo el super admin puede quitarlos."}</p>`) : ""}
    ${admin ? tabla("Encargados de mantenimiento", usuarios.filter((u) => u.rol === "encargado")) : ""}
    ${tabla("Estudiantes", usuarios.filter((u) => u.rol === "estudiante")) || `<section class="tarjeta"><p class="vacio">Aún no hay estudiantes. Usa “Importar estudiantes” para pegar la lista del grupo.</p></section>`}`;
};

function puedeTocar(u) {
  const r = estado.usuario.rol;
  if (r === "superadmin") return true;
  if (r === "admin") return u.rol === "encargado" || u.rol === "estudiante";
  return u.rol === "estudiante";
}

VISTAS.ajustes = async () => {
  const { ajustes: a } = await api("ajustes");
  app.innerHTML = `
    <h1>Clima y horarios</h1>
    <p class="suave">Estas reglas deciden si se riega cada día. El clima se consulta automáticamente con Open-Meteo.</p>
    <form class="tarjeta" id="f-ajustes">
      <h2>Ubicación del área verde</h2>
      <div class="campos">
        <div class="campo"><label>Lugar</label><input name="lugar" value="${esc(a.lugar)}" /></div>
        <div class="campo"><label>Latitud</label><input name="lat" type="number" step="0.0001" value="${a.lat}" /></div>
        <div class="campo"><label>Longitud</label><input name="lon" type="number" step="0.0001" value="${a.lon}" /></div>
      </div>
      <h2>Reglas de riego</h2>
      <div class="campos">
        <div class="campo"><label>Cancelar riego si se pronostica (mm)</label><input name="umbralLluviaMm" type="number" step="0.5" min="0" value="${a.umbralLluviaMm}" /><p class="ayuda">Lluvia pronosticada para hoy.</p></div>
        <div class="campo"><label>Cancelar riego si ayer llovió (mm)</label><input name="umbralLluviaAyerMm" type="number" step="0.5" min="0" value="${a.umbralLluviaAyerMm}" /><p class="ayuda">La tierra sigue húmeda.</p></div>
        <div class="campo"><label>Día seco y caluroso desde (°C)</label><input name="umbralCalorC" type="number" step="0.5" value="${a.umbralCalorC}" /><p class="ayuda">Temperatura máxima del día.</p></div>
      </div>
      <h2>Turnos</h2>
      <div class="campo"><label>Días con turnos</label><div class="dias">${DIAS.map(
        (d, i) => `<label><input type="checkbox" name="dia" value="${i}" ${a.diasActivos.includes(i) ? "checked" : ""}/> ${d}</label>`
      ).join("")}</div></div>
      <div class="campos">
        <div class="campo"><label>Hora límite turno de mañana</label><input name="limiteManana" type="time" value="${a.limiteManana}" /></div>
        <div class="campo"><label>Hora límite turno de tarde</label><input name="limiteTarde" type="time" value="${a.limiteTarde}" /></div>
      </div>
      <button class="btn">Guardar ajustes</button>
    </form>`;
  $("#f-ajustes").onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const datos = Object.fromEntries(fd);
    datos.diasActivos = fd.getAll("dia").map(Number);
    try {
      await api("ajustes", { method: "PUT", body: datos });
      avisar("Ajustes guardados.");
    } catch (e) {
      avisar(e.message, true);
    }
  };
};

VISTAS.cuenta = async () => {
  const u = estado.usuario;
  app.innerHTML = `
    <h1>Mi cuenta</h1>
    <section class="tarjeta"><p><b>${esc(u.nombre)}</b><br><span class="suave">${ROL[u.rol]}${u.matricula ? " · Matrícula " + esc(u.matricula) : ""}</span></p></section>
    <form class="tarjeta" id="f-pass">
      <h2>Cambiar contraseña</h2>
      ${u.debeCambiar ? '<div class="banner aviso-ambar">Todavía usas tu contraseña inicial. Te recomendamos cambiarla.</div>' : ""}
      <div class="campo"><label>Contraseña actual</label><input name="actual" type="password" required autocomplete="current-password" /></div>
      <div class="campo"><label>Nueva contraseña</label><input name="nueva" type="password" minlength="6" required autocomplete="new-password" /></div>
      <button class="btn">Guardar</button>
    </form>
    <section class="tarjeta"><h2>Notificaciones</h2>${await (async () => {
      const e = await estadoNotif();
      if (e === "activas")
        return `<p>Activas en este dispositivo. Recibirás un aviso cuando te toque regar, un recordatorio 1 hora antes del límite y un aviso si el turno queda sin registrar.</p>
        <div class="fila"><button class="btn chico sec" data-accion="probar-notif">Enviar prueba</button><button class="btn chico sec" data-accion="desactivar-notif">Desactivar</button></div>`;
      const t = TEXTO_NOTIF[e];
      return `<p><b>${t.t}.</b> ${t.d}</p>${t.b}`;
    })()}</section>
    <section class="tarjeta"><h2>Privacidad</h2><p class="suave">El sistema solo guarda tu nombre, tu matrícula y tus turnos. Tus incumplimientos y sanciones solo los ve el administrador; nadie más del grupo.</p></section>`;
  $("#f-pass").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      await api("yo/password", { method: "POST", body: Object.fromEntries(new FormData(ev.target)) });
      estado.usuario.debeCambiar = false;
      ev.target.reset();
      avisar("Contraseña actualizada.");
    } catch (e) {
      avisar(e.message, true);
    }
  };
};

// ------------------------------------------------------------ acciones
const ACCIONES = {
  salir: () => cerrarSesion(),

  async "activar-notif"(b) {
    b.disabled = true;
    try {
      await activarNotif();
      if (estado.vista === "cuenta") ir("cuenta");
    } finally {
      b.disabled = false;
    }
  },
  async "probar-notif"() {
    const r = await api("push/prueba", { method: "POST" });
    avisar(r.enviados ? "Notificación de prueba enviada." : "Este dispositivo no está suscrito todavía.", !r.enviados);
  },
  async "desactivar-notif"() {
    await desactivarNotif();
    avisar("Notificaciones desactivadas en este dispositivo.");
    ir("cuenta");
    pintarNotif();
  },
  async instalar() {
    if (!eventoInstalar) return;
    eventoInstalar.prompt();
    await eventoInstalar.userChoice.catch(() => {});
    eventoInstalar = null;
    pintarNotif();
  },

  async hecha(b) {
    b.disabled = true;
    try {
      await api(`tareas/${b.dataset.id}/hecha`, { method: "POST" });
      avisar("¡Gracias! Riego registrado.");
      ir(estado.vista, estado.extra);
    } catch (e) {
      avisar(e.message, true);
      b.disabled = false;
    }
  },

  justificar(b) {
    abrirModal(
      `<h2>Justificar turno</h2><p class="suave">Explica por qué no pudiste cumplir. El administrador revisará tu justificación antes de decidir.</p>
       <div class="campo"><label>Motivo</label><textarea name="motivo" required minlength="5" maxlength="500"></textarea></div>`,
      async (d) => {
        await api(`tareas/${b.dataset.id}/justificar`, { method: "POST", body: d });
        avisar("Justificación enviada.");
        ir(estado.vista, estado.extra);
      }
    );
  },

  async reasignar(b) {
    const { usuarios } = await api("usuarios");
    const ests = usuarios.filter((u) => u.rol === "estudiante" && u.activo !== false);
    abrirModal(
      `<h2>Reasignar turno</h2><div class="campo"><label>Estudiante</label><select name="estudianteId">${ests
        .map((e) => `<option value="${e.id}">${esc(e.nombre)}</option>`)
        .join("")}</select></div>`,
      async (d) => {
        await api(`tareas/${b.dataset.id}/reasignar`, { method: "POST", body: d });
        avisar("Turno reasignado.");
        ir("hoy");
      }
    );
  },

  lluvia() {
    confirmar("Se cancelarán todos los riegos pendientes de hoy y se registrarán como cubiertos por lluvia.", async () => {
      const r = await api("dia/lluvia", { method: "POST" });
      avisar(`${r.canceladas} riego(s) cancelados por lluvia.`);
      ir("hoy");
    }, "Sí, llovió");
  },

  regenerar() {
    confirmar("Se recalcularán los turnos pendientes de hoy con el clima actual y las plantas registradas. Los turnos ya hechos se conservan.", async () => {
      await api("dia/regenerar", { method: "POST" });
      avisar("Turnos generados.");
      ir("hoy");
    }, "Generar");
  },

  resolver(b) {
    const ok = b.dataset.ok === "1";
    abrirModal(
      `<h2>${ok ? "Aceptar" : "Rechazar"} justificación</h2>
       <div class="campo"><label>Respuesta para el estudiante (opcional)</label><input name="respuesta" maxlength="300" /></div>`,
      async (d) => {
        await api(`tareas/${b.dataset.id}/resolver`, { method: "POST", body: { aceptar: ok, respuesta: d.respuesta } });
        avisar(ok ? "Justificación aceptada." : "Justificación rechazada.");
        ir("panel");
      }
    );
  },

  sancionar(b) {
    const r = estado.cache.resumen;
    const est = r.estudiantes.find((e) => e.id === b.dataset.est);
    const pendientes = r.incumplidas.filter((t) => t.estudianteId === est.id);
    const marcada = b.dataset.tarea;
    abrirModal(
      `<h2>Sanción para ${esc(est.nombre)}</h2>
       <p class="suave">Elige una sanción del catálogo acordado. Antes de sancionar, verifica que el estudiante haya tenido oportunidad de justificarse.</p>
       <div class="campo"><label>Sanción</label><select name="catalogoId" required>${estado.cache.catalogo
         .sort((a, b) => a.nivel - b.nivel)
         .map((c) => `<option value="${c.id}">${esc(c.nombre)} — ${esc(c.descripcion)}</option>`)
         .join("")}</select></div>
       ${pendientes.length ? `<div class="campo"><label>Turnos no cumplidos que cubre</label>${pendientes
         .map(
           (t) => `<label style="font-weight:400;display:flex;gap:8px;align-items:center"><input type="checkbox" name="t_${t.fecha}_${t.id}" style="width:auto" ${!marcada || marcada === `${t.fecha}_${t.id}` ? "checked" : ""}/> ${fechaBonita(t.fecha)} · ${esc(t.plantaNombre)} (${esc(t.turno)})</label>`
         )
         .join("")}</div>` : ""}
       <div class="campo"><label>Nota (opcional)</label><input name="nota" maxlength="400" placeholder="Ej. Cubrir el turno del viernes" /></div>`,
      async (d) => {
        const tareaIds = Object.keys(d).filter((k) => k.startsWith("t_")).map((k) => k.slice(2));
        await api("sanciones", { method: "POST", body: { estudianteId: est.id, catalogoId: d.catalogoId, nota: d.nota, tareaIds } });
        avisar("Sanción registrada.");
        ir("panel");
      }
    );
    $("#modal-form button[value=ok]").textContent = "Aplicar";
  },

  "nueva-sancion"() {
    abrirModal(
      `<h2>Nueva sanción en el catálogo</h2>
       <div class="campo"><label>Nombre</label><input name="nombre" required /></div>
       <div class="campo"><label>Descripción</label><input name="descripcion" /></div>
       <div class="campo"><label>Nivel (1 = la más leve)</label><input name="nivel" type="number" min="1" value="${(estado.cache.catalogo?.length || 4) + 1}" /></div>`,
      async (d) => {
        await api("sanciones/catalogo", { method: "POST", body: d });
        ir("sanciones");
      }
    );
  },
  "borrar-cat"(b) {
    confirmar("Se quitará esta sanción del catálogo.", async () => {
      await api(`sanciones/catalogo/${b.dataset.id}`, { method: "DELETE" });
      ir("sanciones");
    }, "Quitar");
  },
  async "sancion-cumplida"(b) {
    await api(`sanciones/${b.dataset.id}/cumplida`, { method: "POST" });
    avisar("Sanción marcada como cumplida.");
    ir("sanciones");
  },
  "borrar-sancion"(b) {
    confirmar("Se eliminará el registro de esta sanción.", async () => {
      await api(`sanciones/${b.dataset.id}`, { method: "DELETE" });
      ir("sanciones");
    }, "Eliminar");
  },

  "nueva-zona"() {
    abrirModal(
      `<h2>Nueva zona</h2><div class="campo"><label>Nombre</label><input name="nombre" required placeholder="Ej. Zona norte" /></div>
       <div class="campo"><label>Descripción (opcional)</label><input name="descripcion" /></div>`,
      async (d) => {
        await api("areas", { method: "POST", body: d });
        ir("plantas");
      }
    );
  },
  "editar-zona"(b) {
    const a = estado.cache.areas.find((x) => x.id === b.dataset.id);
    abrirModal(
      `<h2>Editar zona</h2><div class="campo"><label>Nombre</label><input name="nombre" required value="${esc(a.nombre)}" /></div>
       <div class="campo"><label>Descripción</label><input name="descripcion" value="${esc(a.descripcion)}" /></div>`,
      async (d) => {
        await api(`areas/${a.id}`, { method: "PUT", body: d });
        ir("plantas");
      }
    );
  },
  "borrar-zona"(b) {
    confirmar("Se eliminará esta zona.", async () => {
      await api(`areas/${b.dataset.id}`, { method: "DELETE" });
      ir("plantas");
    }, "Eliminar");
  },

  "nueva-planta"() {
    if (!estado.cache.areas.length) return avisar("Primero crea una zona.", true);
    abrirModal(formPlanta({}, estado.cache.areas), async (d) => {
      await api("plantas", { method: "POST", body: d });
      avisar("Planta agregada.");
      ir("plantas");
    });
    const sel = $("#preset");
    sel.onchange = () => {
      const p = PRESETS.find((x) => x[0] === sel.value);
      if (!p || !p[0]) return;
      const f = $("#modal-form");
      f.cadaDias.value = p[2];
      f.vecesSeco.value = p[3];
      f.litros.value = p[4];
      if (!f.especie.value) f.especie.value = p[1];
    };
  },
  "editar-planta"(b) {
    const p = estado.cache.plantas.find((x) => x.id === b.dataset.id);
    abrirModal(formPlanta(p, estado.cache.areas), async (d) => {
      await api(`plantas/${p.id}`, { method: "PUT", body: d });
      ir("plantas");
    });
  },
  "borrar-planta"(b) {
    confirmar("Se eliminará esta planta. Sus turnos anteriores se conservan en el historial.", async () => {
      await api(`plantas/${b.dataset.id}`, { method: "DELETE" });
      ir("plantas");
    }, "Eliminar");
  },
  "importar-plantas"() {
    abrirModal(
      `<h2>Importar plantas</h2>
       <p class="suave">Una planta por línea, separando con punto y coma:<br><code>Nombre; Especie; Zona; regar cada N días; veces si está seco; litros</code></p>
       <p class="suave">Ejemplo:<br><code>Fresno 1; Fresno; Zona norte; 2; 1; 15</code></p>
       <div class="campo"><textarea name="texto" required style="min-height:160px"></textarea></div>
       <p class="ayuda">Si la zona no existe, se crea automáticamente.</p>`,
      async (d) => {
        const plantas = d.texto
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const [nombre, especie, zona, cadaDias, vecesSeco, litros] = l.split(/[;\t]/).map((s) => (s || "").trim());
            return { nombre, especie, zona, cadaDias: cadaDias || 1, vecesSeco: vecesSeco || 0, litros: litros || "" };
          });
        const r = await api("plantas/importar", { method: "POST", body: { plantas } });
        avisar(`${r.importadas} planta(s) importadas.`);
        ir("plantas");
      }
    );
  },

  "nuevo-usuario"(b) {
    const asignables = estado.cache.asignables || ["estudiante"];
    const pre = b.dataset.rol || "estudiante";
    abrirModal(
      `<h2>${pre === "admin" ? "Agregar administrador" : asignables.length > 1 ? "Agregar usuario" : "Agregar estudiante"}</h2>
       <div class="campo"><label>Nombre completo</label><input name="nombre" required /></div>
       <div class="campo"><label>Matrícula o número de empleado</label><input name="matricula" required minlength="4" /><p class="ayuda">Será su contraseña inicial.</p></div>
       ${asignables.length > 1 ? `<div class="campo"><label>Perfil</label>${selectorRol(asignables, pre)}</div>` : ""}`,
      async (d) => {
        await api("usuarios", { method: "POST", body: d });
        avisar("Usuario agregado.");
        ir("usuarios");
      }
    );
  },
  "importar-est"() {
    abrirModal(
      `<h2>Importar estudiantes</h2>
       <p class="suave">Pega la lista del grupo: un estudiante por línea, con su nombre y su matrícula separados por coma.</p>
       <p class="suave"><code>Ana López Hernández, 2301001</code></p>
       <div class="campo"><textarea name="texto" required style="min-height:180px"></textarea></div>`,
      async (d) => {
        const r = await api("usuarios/importar", { method: "POST", body: d });
        avisar(`${r.creados.length} estudiante(s) agregados.`);
        if (r.errores.length) {
          setTimeout(() => alertaErrores(r.errores), 50);
          return;
        }
        ir("usuarios");
      }
    );
  },
  "editar-usuario"(b) {
    const u = estado.cache.usuarios.find((x) => x.id === b.dataset.id);
    const asignables = estado.cache.asignables || ["estudiante"];
    abrirModal(
      `<h2>Editar usuario</h2>
       <div class="campo"><label>Nombre completo</label><input name="nombre" required value="${esc(u.nombre)}" /></div>
       <div class="campo"><label>Matrícula</label><input name="matricula" value="${esc(u.matricula)}" /><p class="ayuda">Con “Restablecer contraseña” la contraseña pasa a ser esta matrícula.</p></div>
       ${asignables.length > 1 && asignables.includes(u.rol) ? `<div class="campo"><label>Perfil</label>${selectorRol(asignables, u.rol)}</div>` : ""}`,
      async (d) => {
        await api(`usuarios/${u.id}`, { method: "PUT", body: d });
        ir("usuarios");
      }
    );
  },
  restablecer(b) {
    confirmar("La contraseña volverá a ser la matrícula del usuario.", async () => {
      await api(`usuarios/${b.dataset.id}/restablecer`, { method: "POST" });
      avisar("Contraseña restablecida a la matrícula.");
      ir("usuarios");
    }, "Restablecer");
  },
  async activar(b) {
    const u = estado.cache.usuarios.find((x) => x.id === b.dataset.id);
    await api(`usuarios/${u.id}`, { method: "PUT", body: { activo: u.activo === false } });
    ir("usuarios");
  },
  "quitar-admin"(b) {
    const u = estado.cache.usuarios.find((x) => x.id === b.dataset.id);
    abrirModal(
      `<h2>Quitar a ${esc(u.nombre)} como ${u.rol === "superadmin" ? "super admin" : "administrador"}</h2>
       <p class="suave">Elige qué pasa con su cuenta.</p>
       <div class="campo"><label>Acción</label><select name="accion">
         ${u.rol === "superadmin" ? '<option value="admin">Dejarlo como administrador</option>' : ""}
         <option value="encargado">Convertirlo en encargado de mantenimiento</option>
         <option value="estudiante">Convertirlo en estudiante</option>
         <option value="eliminar">Eliminar su cuenta</option>
       </select></div>`,
      async (d) => {
        if (d.accion === "eliminar") await api(`usuarios/${u.id}`, { method: "DELETE" });
        else await api(`usuarios/${u.id}`, { method: "PUT", body: { rol: d.accion } });
        avisar(d.accion === "eliminar" ? "Cuenta eliminada." : "Perfil actualizado.");
        ir("usuarios");
      }
    );
    $("#modal-form button[value=ok]").textContent = "Quitar";
  },
};

const DESC_ROL = {
  superadmin: "Super admin (puede quitar administradores)",
  admin: "Administrador (jefe de grupo o tutor)",
  encargado: "Encargado de mantenimiento",
  estudiante: "Estudiante",
};
function selectorRol(asignables, actual) {
  return `<select name="rol">${["estudiante", "encargado", "admin", "superadmin"]
    .filter((r) => asignables.includes(r))
    .map((r) => `<option value="${r}" ${r === actual ? "selected" : ""}>${DESC_ROL[r]}</option>`)
    .join("")}</select>`;
}
const esAdmin = () => ["admin", "superadmin"].includes(estado.usuario?.rol);

function alertaErrores(errores) {
  abrirModal(`<h2>Algunas líneas no se importaron</h2><ul>${errores.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`, async () => {
    ir("usuarios");
  });
  $("#modal-form button[value=ok]").textContent = "Entendido";
}

document.addEventListener("click", (ev) => {
  const navegar = ev.target.closest("[data-ir]");
  if (navegar) {
    ev.preventDefault();
    return ir(navegar.dataset.ir, navegar.dataset.est ? { estudiante: navegar.dataset.est } : {});
  }
  const b = ev.target.closest("[data-accion]");
  if (b && ACCIONES[b.dataset.accion]) {
    ev.preventDefault();
    Promise.resolve(ACCIONES[b.dataset.accion](b)).catch((e) => avisar(e.message, true));
  }
});

iniciar().catch((e) => (app.innerHTML = `<div class="tarjeta"><p>No se pudo conectar con el servidor: ${esc(e.message)}</p></div>`));
