// Sección pública del área verde: cuestionario para visitantes (se abre con el QR) e información del área.
// No pide nombre ni datos personales.
const $ = (s, el = document) => el.querySelector(s);
const app = $("#app");
const inicio = Date.now();

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function leer(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function guardar(k, v) {
  try { localStorage.setItem(k, v); } catch {}
}
const hoyLocal = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Mexico_City" });

async function api(ruta, opciones = {}) {
  const res = await fetch("/api/" + ruta, {
    method: opciones.method || "GET",
    headers: { "content-type": "application/json" },
    body: opciones.body ? JSON.stringify(opciones.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || "No se pudo conectar (" + res.status + ")");
  return data;
}

function avisar(msg, error = false) {
  const el = $("#aviso");
  el.textContent = msg;
  el.className = "aviso ver" + (error ? " error" : "");
  clearTimeout(avisar.t);
  avisar.t = setTimeout(() => (el.className = "aviso"), 3600);
}

// ------------------------------------------------------------ menú
const SECCIONES = { cuestionario: vistaCuestionario, area: vistaArea };
function ir(sec) {
  if (!SECCIONES[sec]) sec = "cuestionario";
  try { history.replaceState(null, "", "#" + sec); } catch {}
  document.querySelectorAll("#menu button").forEach((b) =>
    b.dataset.sec === sec ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")
  );
  scrollTo({ top: 0 });
  app.innerHTML = `<p class="cargando">Cargando…</p>`;
  SECCIONES[sec]().catch((e) => (app.innerHTML = `<section class="tarjeta"><p>${esc(e.message)}</p></section>`));
}
$("#menu").addEventListener("click", (e) => {
  const b = e.target.closest("[data-sec]");
  if (b) ir(b.dataset.sec);
});

// ------------------------------------------------------------ cuestionario
let preguntas = null;

async function vistaCuestionario() {
  if (!preguntas) preguntas = (await api("encuesta/preguntas")).preguntas;
  if (leer("av_encuesta") === hoyLocal()) return vistaGracias(true);

  app.innerHTML = `
    <h1>¿Cómo te sientes en el área verde?</h1>
    <p class="suave">Son ${preguntas.length} preguntas de opción y toma unos 2 minutos.</p>
    <div class="banner info">Es <b>anónimo</b>: no pedimos tu nombre ni datos que te identifiquen. Las respuestas solo las ven
      los docentes y administradores del proyecto, en resultados generales.</div>
    <div class="progreso" aria-hidden="true"><i id="barra-progreso"></i></div>
    <p class="suave progreso-texto" id="progreso-texto">0 de ${preguntas.length} respondidas</p>
    <form id="f-encuesta" novalidate>
      ${preguntas
        .map(
          (p, i) => `
        <fieldset class="tarjeta pregunta" id="p-${p.id}">
          <legend><span class="num-pregunta">${i + 1}</span>${esc(p.texto)}</legend>
          ${p.multiple ? '<p class="ayuda">Puedes elegir varias.</p>' : ""}
          <div class="opciones">
            ${p.opciones
              .map(
                (o) => `<label class="opcion"><input type="${p.multiple ? "checkbox" : "radio"}" name="${p.id}" value="${esc(o)}" /><span>${esc(o)}</span></label>`
              )
              .join("")}
          </div>
        </fieldset>`
        )
        .join("")}
      <div class="trampa" aria-hidden="true"><label>Sitio web<input name="sitio" tabindex="-1" autocomplete="off" /></label></div>
      <button class="btn bloque grande">Enviar respuestas</button>
    </form>`;

  const form = $("#f-encuesta");
  const contestadas = () => preguntas.filter((p) => form.querySelector(`[name="${p.id}"]:checked`)).length;
  form.addEventListener("change", (e) => {
    const n = contestadas();
    $("#barra-progreso").style.width = (n / preguntas.length) * 100 + "%";
    $("#progreso-texto").textContent = `${n} de ${preguntas.length} respondidas`;
    e.target.closest(".pregunta")?.classList.remove("falta");
  });

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const respuestas = {};
    let primeraFalta = null;
    for (const p of preguntas) {
      const marcadas = [...form.querySelectorAll(`[name="${p.id}"]:checked`)].map((x) => x.value);
      const caja = $(`#p-${p.id}`);
      if (!marcadas.length) {
        caja.classList.add("falta");
        primeraFalta ||= caja;
      }
      respuestas[p.id] = p.multiple ? marcadas : marcadas[0];
    }
    if (primeraFalta) {
      primeraFalta.scrollIntoView({ behavior: "smooth", block: "center" });
      return avisar("Te falta responder alguna pregunta.", true);
    }
    const btn = form.querySelector("button");
    btn.disabled = true;
    btn.textContent = "Enviando…";
    try {
      await api("encuesta/respuestas", {
        method: "POST",
        body: { respuestas, sitio: form.sitio.value, ms: Date.now() - inicio },
      });
      guardar("av_encuesta", hoyLocal());
      vistaGracias(false);
    } catch (e) {
      avisar(e.message, true);
      btn.disabled = false;
      btn.textContent = "Enviar respuestas";
    }
  };
}

function vistaGracias(yaRespondio) {
  scrollTo({ top: 0 });
  app.innerHTML = `
    <section class="tarjeta gracias">
      <div class="logo-grande"><img src="favicon.svg" width="72" height="72" alt="" /></div>
      <h1>${yaRespondio ? "Ya respondiste hoy" : "¡Gracias por responder!"}</h1>
      <p>Tus respuestas nos ayudan a saber si el área verde ayuda a reducir el estrés en la universidad.</p>
      <p class="suave">Antes de irte, prueba esto: inhala por la nariz contando 4, sostén 4 y exhala despacio contando 6. Repite tres veces.</p>
      <p class="suave">Si te sientes estresado(a) o con ansiedad muy seguido, platícalo con alguien de confianza o busca el apoyo psicológico de tu escuela.</p>
      <div class="fila centro">
        <button class="btn sec" data-sec-ir="area">Conocer el área verde</button>
        ${yaRespondio ? '<button class="btn sec" id="otra-vez">Responder otra vez</button>' : ""}
      </div>
    </section>`;
  app.querySelector("[data-sec-ir]").onclick = () => ir("area");
  const otra = $("#otra-vez");
  if (otra)
    otra.onclick = () => {
      try { localStorage.removeItem("av_encuesta"); } catch {}
      ir("cuestionario");
    };
}

// ------------------------------------------------------------ información del área verde
const DECISION = { lluvia: "Hoy no se riega: la lluvia se encarga", seco: "Día seco: riego reforzado", normal: "Riego normal" };

async function vistaArea() {
  const d = await api("publico/area");
  const clima = d.clima
    ? `<section class="tarjeta">
        <h2>Clima de hoy en ${esc(d.clima.lugar)}</h2>
        <p><b>${d.clima.actual ? Math.round(d.clima.actual.temp) + " °C" : ""}</b> ${esc(d.clima.actual?.descripcion || d.clima.hoy?.descripcion || "")}
        · Máx ${Math.round(d.clima.hoy.max)}° / Mín ${Math.round(d.clima.hoy.min)}°</p>
        <div class="decision ${esc(d.clima.decision.tipo)}"><div><strong>${DECISION[d.clima.decision.tipo] || ""}</strong><span>${esc(d.clima.decision.motivo)}</span></div></div>
      </section>`
    : "";
  const zonas = d.zonas.length
    ? d.zonas
        .map(
          (z) => `<section class="tarjeta"><h2>${esc(z.nombre)}</h2>${z.descripcion ? `<p class="suave">${esc(z.descripcion)}</p>` : ""}
          ${z.plantas.length
            ? `<ul class="lista-plantas">${z.plantas.map((p) => `<li><b>${esc(p.nombre)}</b>${p.especie ? ` <span class="suave">· ${esc(p.especie)}</span>` : ""}</li>`).join("")}</ul>`
            : '<p class="vacio">Pronto registraremos sus plantas.</p>'}</section>`
        )
        .join("")
    : `<section class="tarjeta"><p class="vacio">Estamos registrando las zonas y plantas del área verde. Vuelve pronto.</p></section>`;
  app.innerHTML = `
    <h1>El área verde</h1>
    <p>Un espacio construido y cuidado por estudiantes de la Universidad Politécnica de Tulancingo para relajarse, convivir y
      cuidar el ambiente. El riego se organiza por turnos y se ajusta al clima para no desperdiciar agua.</p>
    <div class="stats">
      <div class="stat"><b>${d.zonas.length}</b><small>Zonas</small></div>
      <div class="stat"><b>${d.totalPlantas}</b><small>Árboles y plantas</small></div>
    </div>
    ${clima}
    ${zonas}
    <section class="tarjeta"><h2>Ayúdanos a cuidarla</h2>
      <p class="suave">No pises las zonas recién plantadas, deposita la basura en su lugar y, si ves una planta seca o dañada, avísale al equipo de mantenimiento.</p>
      <button class="btn" data-sec-ir="cuestionario">Responder el cuestionario</button></section>`;
  app.querySelector("[data-sec-ir]").onclick = () => ir("cuestionario");
}

ir(location.hash.slice(1));
