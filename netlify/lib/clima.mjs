// Conexión con el clima (Open-Meteo: gratis y sin clave) y regla de riego.
import * as db from "./store.mjs";

export const TZ = "America/Mexico_City";

export const AJUSTES_DEFAULT = {
  lugar: "Tulancingo, Hidalgo",
  lat: 20.0833,
  lon: -98.3667,
  umbralLluviaMm: 5, // lluvia pronosticada hoy que cancela el riego
  umbralLluviaAyerMm: 10, // lluvia fuerte de ayer que también cancela el riego
  umbralCalorC: 28, // temperatura máxima a partir de la cual el día es "seco y caluroso"
  diasActivos: [1, 2, 3, 4, 5], // 0 = domingo ... 6 = sábado
  limiteManana: "12:00",
  limiteTarde: "18:00",
};

export async function getAjustes() {
  return { ...AJUSTES_DEFAULT, ...(await db.get("config/ajustes", {})) };
}

// Fecha y hora locales de Tulancingo
export function ahoraLocal(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  const dias = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    fecha: `${parts.year}-${parts.month}-${parts.day}`,
    hora: `${parts.hour}:${parts.minute}`,
    diaSemana: dias[parts.weekday],
  };
}

export function sumarDias(fecha, n) {
  const d = new Date(fecha + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function diasEntre(a, b) {
  return Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 86400e3);
}

const DESCRIPCION = {
  0: "Despejado", 1: "Mayormente despejado", 2: "Parcialmente nublado", 3: "Nublado",
  45: "Niebla", 48: "Niebla", 51: "Llovizna ligera", 53: "Llovizna", 55: "Llovizna intensa",
  61: "Lluvia ligera", 63: "Lluvia", 65: "Lluvia fuerte", 66: "Lluvia helada", 67: "Lluvia helada",
  71: "Nieve ligera", 73: "Nieve", 75: "Nieve fuerte", 80: "Chubascos", 81: "Chubascos",
  82: "Chubascos fuertes", 95: "Tormenta", 96: "Tormenta con granizo", 99: "Tormenta con granizo",
};

async function descargar(aj) {
  if (process.env.AREAS_CLIMA_MOCK) return JSON.parse(process.env.AREAS_CLIMA_MOCK);
  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${aj.lat}&longitude=${aj.lon}` +
    "&current=temperature_2m,relative_humidity_2m,precipitation,weather_code" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max" +
    `&timezone=${encodeURIComponent(TZ)}&past_days=1&forecast_days=4`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error("Open-Meteo respondió " + res.status);
  return res.json();
}

// Devuelve el clima de hoy, ayer, próximos días y la decisión de riego.
export async function obtenerClima() {
  const aj = await getAjustes();
  const { fecha } = ahoraLocal();
  const cache = await db.get("clima/cache");
  let raw = null;
  if (cache && cache.fecha === fecha && Date.now() - cache.at < 30 * 60e3 && !process.env.AREAS_CLIMA_MOCK) {
    raw = cache.raw;
  } else {
    try {
      raw = await descargar(aj);
      await db.set("clima/cache", { at: Date.now(), fecha, raw });
    } catch (e) {
      raw = cache?.raw || null;
      if (!raw) return { disponible: false, error: String(e.message || e), decision: decidir(null, aj) };
    }
  }

  const d = raw.daily;
  const dias = d.time.map((t, i) => ({
    fecha: t,
    descripcion: DESCRIPCION[d.weather_code[i]] || "—",
    codigo: d.weather_code[i],
    max: d.temperature_2m_max[i],
    min: d.temperature_2m_min[i],
    lluviaMm: d.precipitation_sum[i] ?? 0,
    probLluvia: d.precipitation_probability_max?.[i] ?? null,
  }));
  const hoy = dias.find((x) => x.fecha === fecha) || dias[1] || dias[0];
  const ayer = dias.find((x) => x.fecha === sumarDias(fecha, -1)) || null;
  const actual = raw.current
    ? {
        temp: raw.current.temperature_2m,
        humedad: raw.current.relative_humidity_2m,
        lluviaMm: raw.current.precipitation,
        descripcion: DESCRIPCION[raw.current.weather_code] || "—",
        codigo: raw.current.weather_code,
      }
    : null;

  return {
    disponible: true,
    lugar: aj.lugar,
    actual,
    hoy,
    ayer,
    proximos: dias.filter((x) => x.fecha > fecha),
    decision: decidir({ hoy, ayer }, aj),
  };
}

// Regla de riego del día:
//  - "lluvia": se cancela el riego (llueve hoy o llovió fuerte ayer)
//  - "seco":   día caluroso sin lluvia; las plantas que lo necesitan se riegan más veces
//  - "normal": se sigue la frecuencia normal de cada planta
export function decidir(clima, aj) {
  if (!clima || !clima.hoy) {
    return { tipo: "normal", motivo: "No se pudo consultar el clima; se usa la frecuencia normal." };
  }
  const { hoy, ayer } = clima;
  if (hoy.lluviaMm >= aj.umbralLluviaMm) {
    return {
      tipo: "lluvia",
      motivo: `Se pronostican ${hoy.lluviaMm} mm de lluvia hoy (umbral ${aj.umbralLluviaMm} mm): no hace falta regar.`,
    };
  }
  if (ayer && ayer.lluviaMm >= aj.umbralLluviaAyerMm) {
    return {
      tipo: "lluvia",
      motivo: `Ayer llovieron ${ayer.lluviaMm} mm (umbral ${aj.umbralLluviaAyerMm} mm): la tierra sigue húmeda.`,
    };
  }
  if (hoy.max >= aj.umbralCalorC) {
    return {
      tipo: "seco",
      motivo: `Día seco y caluroso (máxima de ${hoy.max} °C, sin lluvia): las plantas que lo requieren se riegan más.`,
    };
  }
  return {
    tipo: "normal",
    motivo: `Clima templado (máxima de ${hoy.max} °C, ${hoy.lluviaMm} mm de lluvia): frecuencia normal de riego.`,
  };
}
