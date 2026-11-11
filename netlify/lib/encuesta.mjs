// Cuestionario para visitantes del área verde (anónimo).
// Las preguntas viven aquí para que la página pública y la de resultados usen las mismas.
import crypto from "node:crypto";
import * as db from "./store.mjs";

export const VERSION = 1;

export const PREGUNTAS = [
  { id: "q1", texto: "¿A qué carrera perteneces?", opciones: ["Psicología", "Administración", "Ingeniería", "Otra"] },
  {
    id: "q2",
    texto: "¿Cómo te sentías antes de ingresar al área verde?",
    opciones: ["Tranquilo(a)", "Estresado(a)", "Cansado(a)", "Ansioso(a)", "Preocupado(a)"],
  },
  {
    id: "q3",
    texto: "¿Qué situaciones te generan mayor estrés?",
    multiple: true,
    opciones: ["Tareas y trabajos escolares", "Exámenes", "Problemas familiares", "Problemas personales", "Problemas económicos", "Otros"],
  },
  {
    id: "q4",
    texto: "¿Con qué frecuencia te sientes estresado(a)?",
    opciones: ["Siempre", "Casi siempre", "A veces", "Casi nunca", "Nunca"],
  },
  {
    id: "q5",
    texto: "¿Cómo te sentiste después de pasar tiempo en el área verde?",
    opciones: ["Más relajado(a)", "Más tranquilo(a)", "Con mejor ánimo", "Igual que antes", "Más estresado(a)"],
  },
  {
    id: "q6",
    texto: "¿Consideras que el área verde te ayudó a reducir el estrés?",
    opciones: ["Sí, mucho", "Sí, un poco", "No noté ningún cambio", "No"],
  },
  {
    id: "q7",
    texto: "¿Consideras que realizar actividades de mindfulness te ayudaría a controlar el estrés y la ansiedad?",
    opciones: ["Sí", "Tal vez", "No"],
  },
  {
    id: "q8",
    texto: "Después de esta experiencia, ¿volverías a utilizar el área verde para relajarte cuando te sientas estresado(a)?",
    opciones: ["Sí", "No", "Tal vez"],
  },
  {
    id: "q9",
    texto: "¿Qué emoción experimentas con mayor frecuencia durante tu jornada escolar?",
    opciones: ["Alegría", "Estrés", "Ansiedad", "Tristeza", "Frustración"],
  },
  {
    id: "q10",
    texto: "¿Qué tan importante consideras cuidar tu salud emocional?",
    opciones: ["Muy importante", "Importante", "Poco importante", "Nada importante"],
  },
  {
    id: "q11",
    texto: "¿Cómo describirías tu nivel de estrés después de realizar ejercicios de respiración?",
    opciones: ["Disminuyó mucho", "Disminuyó un poco", "Siguió igual", "Aumentó"],
  },
  {
    id: "q12",
    texto: "¿Recomendarías esta experiencia del área verde a otros estudiantes?",
    opciones: ["Sí", "No", "Tal vez"],
  },
];

// Revisa que cada respuesta sea una de las opciones. Devuelve las respuestas limpias o un mensaje de error.
export function validar(r) {
  if (!r || typeof r !== "object") return { error: "Faltan las respuestas." };
  const limpio = {};
  for (const p of PREGUNTAS) {
    const v = r[p.id];
    if (p.multiple) {
      const lista = [...new Set((Array.isArray(v) ? v : [v]).filter((x) => p.opciones.includes(x)))];
      if (!lista.length) return { error: `Responde la pregunta: ${p.texto}` };
      limpio[p.id] = lista;
    } else {
      if (!p.opciones.includes(v)) return { error: `Responde la pregunta: ${p.texto}` };
      limpio[p.id] = v;
    }
  }
  return { respuestas: limpio };
}

// Las claves empiezan con la hora para que queden en orden de llegada
export async function guardar(respuestas, fecha) {
  const en = Date.now();
  const id = en.toString(36).padStart(9, "0") + "-" + crypto.randomBytes(4).toString("hex");
  const doc = { id, en, fecha, v: VERSION, r: respuestas };
  await db.set(`encuesta/${id}`, doc);
  cache.set(`encuesta/${id}`, doc);
  return doc;
}

// Las respuestas no cambian, así que se guardan en memoria mientras la función siga activa
// y en cada consulta solo se leen las nuevas.
const cache = new Map();
export async function todas() {
  const claves = await db.list("encuesta/");
  const vigentes = new Set(claves);
  for (const k of cache.keys()) if (!vigentes.has(k)) cache.delete(k);
  const faltan = claves.filter((k) => !cache.has(k));
  if (faltan.length) {
    const docs = await db.getMany(faltan);
    faltan.forEach((k, i) => docs[i] && cache.set(k, docs[i]));
  }
  return claves.map((k) => cache.get(k)).filter(Boolean).sort((a, b) => a.en - b.en);
}

export async function borrarTodas() {
  const claves = await db.list("encuesta/");
  for (const k of claves) await db.del(k);
  cache.clear();
  return claves.length;
}

// Cuenta las respuestas de cada opción.
// En preguntas de varias opciones el porcentaje es sobre las personas que respondieron.
export function resumir(lista, { desde = null, carrera = "" } = {}) {
  const filtradas = lista.filter((d) => (!desde || d.fecha >= desde) && (!carrera || d.r?.q1 === carrera));
  const n = filtradas.length;
  const preguntas = PREGUNTAS.map((p) => {
    const conteo = Object.fromEntries(p.opciones.map((o) => [o, 0]));
    for (const d of filtradas) {
      const v = d.r?.[p.id];
      for (const o of Array.isArray(v) ? v : [v]) if (o in conteo) conteo[o]++;
    }
    return {
      id: p.id,
      texto: p.texto,
      multiple: !!p.multiple,
      opciones: p.opciones.map((o) => ({ opcion: o, n: conteo[o], pct: n ? Math.round((conteo[o] / n) * 1000) / 10 : 0 })),
    };
  });
  return { total: n, preguntas, ultima: filtradas.length ? filtradas[filtradas.length - 1].en : null };
}

export function porDia(lista, fechas) {
  const c = Object.fromEntries(fechas.map((f) => [f, 0]));
  for (const d of lista) if (d.fecha in c) c[d.fecha]++;
  return fechas.map((f) => ({ fecha: f, n: c[f] }));
}
