// Generación de turnos de riego y cálculo del estado de cada tarea.
import crypto from "node:crypto";
import * as db from "./store.mjs";
import { ahoraLocal, diasEntre, getAjustes, obtenerClima } from "./clima.mjs";

export const nuevoId = () => crypto.randomBytes(6).toString("hex");

export async function usuarios() {
  return db.get("usuarios", []);
}

export async function estudiantesActivos() {
  return (await usuarios())
    .filter((u) => u.rol === "estudiante" && u.activo !== false)
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
}

// Estado real considerando la hora límite
export function estadoEfectivo(t, ahora = ahoraLocal()) {
  if (t.estado !== "pendiente") return t.estado;
  if (t.fecha < ahora.fecha) return "incumplida";
  if (t.fecha === ahora.fecha && ahora.hora > t.limite) return "incumplida";
  return "pendiente";
}

export function conEstado(t, ahora) {
  return { ...t, estadoReal: estadoEfectivo(t, ahora) };
}

export async function tareasDelDia(fecha) {
  const keys = await db.list(`tarea/${fecha}/`);
  return (await db.getMany(keys)).filter(Boolean);
}

export async function tareasRango(desde, hasta) {
  const keys = (await db.list("tarea/")).filter((k) => {
    const f = k.split("/")[1];
    return f >= desde && f <= hasta;
  });
  return (await db.getMany(keys)).filter(Boolean);
}

export const claveTarea = (t) => `tarea/${t.fecha}/${t.id}`;

// Cuántas veces se riega una planta hoy según el clima y su último riego
export function vecesHoy(planta, decision, ultimoRiego, fecha) {
  if (decision.tipo === "lluvia") return 0;
  const cada = Math.max(1, Number(planta.cadaDias) || 1);
  const toca = !ultimoRiego || diasEntre(ultimoRiego, fecha) >= cada;
  if (decision.tipo === "seco" && Number(planta.vecesSeco) > 0) {
    return Math.min(2, Number(planta.vecesSeco));
  }
  return toca ? 1 : 0;
}

// Crea los turnos del día (solo una vez por día, salvo que se pida regenerar)
export async function generarDia(fecha, { forzar = false } = {}) {
  const hoy = ahoraLocal();
  if (fecha !== hoy.fecha) return db.get(`dia/${fecha}`);
  const existente = await db.get(`dia/${fecha}`);
  if (existente && !forzar) return existente;

  const aj = await getAjustes();
  if (!aj.diasActivos.includes(hoy.diaSemana)) {
    const dia = { fecha, inactivo: true, motivo: "Hoy no es día de turnos (según los ajustes).", at: Date.now() };
    await db.set(`dia/${fecha}`, dia);
    return dia;
  }

  const clima = await obtenerClima();
  const decision = clima.decision;
  const plantas = (await db.get("plantas", [])).filter((p) => p.activa !== false);
  const areas = await db.get("areas", []);
  const estudiantes = await estudiantesActivos();
  const previas = await tareasDelDia(fecha);

  // Al regenerar: se conservan las tareas ya resueltas y se borran las pendientes
  const conservadas = previas.filter((t) => t.estado !== "pendiente");
  for (const t of previas.filter((t) => t.estado === "pendiente")) await db.del(claveTarea(t));
  const ocupado = new Set(conservadas.map((t) => `${t.plantaId}|${t.turno}`));

  const rot = await db.get("rotacion", { puntero: 0 });
  let puntero = rot.puntero || 0;
  const creadas = [];

  for (const p of plantas) {
    const ultimo = (await db.get(`riego/${p.id}`))?.fecha || null;
    if (decision.tipo === "lluvia") {
      await db.set(`riego/${p.id}`, { fecha, porLluvia: true });
      continue;
    }
    const veces = vecesHoy(p, decision, ultimo, fecha);
    let turnos = veces >= 2 ? ["mañana", "tarde"] : veces === 1 ? ["mañana"] : [];
    // Si los turnos se generan tarde, nadie recibe una tarea con la hora límite ya vencida
    const pasoManana = hoy.hora >= aj.limiteManana;
    const pasoTarde = hoy.hora >= aj.limiteTarde;
    if (pasoManana && turnos.length === 2) turnos = ["tarde"];
    else if (pasoManana && turnos.length === 1) turnos = ["tarde"];
    for (const turno of turnos) {
      if (ocupado.has(`${p.id}|${turno}`)) continue;
      const est = estudiantes.length ? estudiantes[puntero % estudiantes.length] : null;
      if (est) puntero++;
      const area = areas.find((a) => a.id === p.areaId);
      const t = {
        id: nuevoId(),
        fecha,
        plantaId: p.id,
        plantaNombre: p.nombre,
        areaNombre: area?.nombre || "Sin zona",
        litros: p.litros || null,
        turno,
        limite: turno === "tarde" ? (pasoTarde ? "23:59" : aj.limiteTarde) : aj.limiteManana,
        estudianteId: est?.id || null,
        estudianteNombre: est?.nombre || "Sin asignar",
        estado: "pendiente",
        creada: Date.now(),
      };
      await db.set(claveTarea(t), t);
      creadas.push(t);
    }
  }
  await db.set("rotacion", { puntero });

  const dia = {
    fecha,
    decision,
    clima: clima.disponible ? { hoy: clima.hoy, ayer: clima.ayer } : null,
    total: creadas.length + conservadas.length,
    at: Date.now(),
  };
  await db.set(`dia/${fecha}`, dia);
  return dia;
}

// El encargado marca el día como lluvioso: se cancelan los riegos pendientes
export async function marcarLluvia(fecha, quien) {
  const tareas = await tareasDelDia(fecha);
  let n = 0;
  for (const t of tareas.filter((t) => t.estado === "pendiente")) {
    t.estado = "lluvia";
    t.canceladaPor = quien;
    await db.set(claveTarea(t), t);
    n++;
  }
  for (const p of await db.get("plantas", [])) await db.set(`riego/${p.id}`, { fecha, porLluvia: true });
  const dia = (await db.get(`dia/${fecha}`)) || { fecha };
  dia.decision = { tipo: "lluvia", motivo: "El encargado registró lluvia en el área verde." };
  await db.set(`dia/${fecha}`, dia);
  return n;
}
