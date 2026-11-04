// Función programada (cada 15 minutos): genera los turnos del día y avisa a los estudiantes.
import * as db from "../lib/store.mjs";
import { ahoraLocal } from "../lib/clima.mjs";
import { generarDia, tareasDelDia } from "../lib/tareas.mjs";
import { enviarA } from "../lib/push.mjs";

export const config = { schedule: "*/15 * * * *" };

const minutos = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

// Envía un aviso solo una vez (se guarda una marca aparte para no tocar la tarea)
async function unaVez(t, tipo, mensaje) {
  const key = `aviso/${t.fecha}/${t.id}/${tipo}`;
  if (await db.get(key)) return false;
  await db.set(key, Date.now());
  await enviarA(t.estudianteId, { ...mensaje, etiqueta: `${t.id}-${tipo}` });
  return true;
}

export async function revisarAvisos() {
  const ahora = ahoraLocal();
  if (ahora.hora < "06:30") return { omitido: "muy temprano" };
  const dia = await generarDia(ahora.fecha);
  if (!dia || dia.inactivo) return { omitido: "día sin turnos" };

  const tareas = (await tareasDelDia(ahora.fecha)).filter((t) => t.estado === "pendiente" && t.estudianteId);
  const ya = minutos(ahora.hora);
  let enviados = 0;

  for (const t of tareas) {
    const limite = minutos(t.limite);
    const desde = t.turno === "tarde" ? limite - 6 * 60 : 0; // el turno de tarde se avisa 6 h antes del límite
    const donde = `${t.plantaNombre} (${t.areaNombre})`;

    if (ya >= desde && ya < limite) {
      if (await unaVez(t, "inicio", {
        titulo: "Te toca regar 🌱",
        cuerpo: `${donde} · turno de ${t.turno}, antes de las ${t.limite}.${t.litros ? ` ~${t.litros} L.` : ""}`,
      })) enviados++;
    }
    if (limite - ya <= 60 && limite - ya > 0) {
      if (await unaVez(t, "recordatorio", {
        titulo: "Queda menos de 1 hora",
        cuerpo: `Recuerda regar ${donde} y marcarlo en la app antes de las ${t.limite}.`,
      })) enviados++;
    }
    if (ya >= limite && ya - limite <= 90) {
      if (await unaVez(t, "vencida", {
        titulo: "Turno sin registrar",
        cuerpo: `No se registró el riego de ${donde}. Si tuviste un motivo, puedes justificarlo en la app.`,
      })) enviados++;
    }
  }
  return { fecha: ahora.fecha, hora: ahora.hora, tareas: tareas.length, enviados };
}

export default async function handler() {
  const r = await revisarAvisos();
  console.log("avisos", JSON.stringify(r));
  return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
}
