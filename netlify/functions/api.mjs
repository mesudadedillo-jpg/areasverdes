// API del sistema de mantenimiento del área verde.
// Todas las rutas viven bajo /api/*
import * as db from "../lib/store.mjs";
import { checkPassword, createToken, hashPassword, normalize, readToken } from "../lib/auth.mjs";
import { AJUSTES_DEFAULT, ahoraLocal, getAjustes, obtenerClima, sumarDias } from "../lib/clima.mjs";
import {
  claveTarea, conEstado, estadoEfectivo, generarDia, marcarLluvia, nuevoId,
  tareasDelDia, tareasRango, usuarios,
} from "../lib/tareas.mjs";

export const config = { path: "/api/*" };

const ROLES = ["admin", "encargado", "estudiante"];
const SANCIONES_DEFAULT = [
  { id: "s1", nombre: "Recordatorio", descripcion: "Aviso privado para que no vuelva a pasar.", nivel: 1 },
  { id: "s2", nombre: "Turno extra de riego", descripcion: "Cubrir un turno adicional en la semana.", nivel: 2 },
  { id: "s3", nombre: "Apoyo en limpieza o deshierbe", descripcion: "Una jornada de limpieza del área verde.", nivel: 3 },
  { id: "s4", nombre: "Plática con el tutor", descripcion: "Reunión con el tutor para acordar compromisos.", nivel: 4 },
];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, msg) => {
  throw new HttpError(status, msg);
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const publico = ({ hash, salt, ...u }) => u;
const texto = (v, max = 200) => String(v ?? "").trim().slice(0, max);

async function body(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

async function sesion(req) {
  const h = req.headers.get("authorization") || "";
  const data = await readToken(h.replace(/^Bearer\s+/i, ""));
  if (!data) fail(401, "Tu sesión terminó. Vuelve a iniciar sesión.");
  const u = (await usuarios()).find((x) => x.id === data.uid);
  if (!u || u.activo === false) fail(401, "Usuario no válido.");
  return u;
}
const exigir = (u, ...roles) => {
  if (!roles.includes(u.rol)) fail(403, "No tienes permiso para esta acción.");
};

async function guardarUsuarios(lista) {
  await db.set("usuarios", lista);
}

function crearUsuario({ nombre, matricula, rol, password }) {
  nombre = texto(nombre, 80);
  matricula = texto(matricula, 30);
  if (!nombre) fail(400, "El nombre es obligatorio.");
  if (!ROLES.includes(rol)) fail(400, "Rol no válido.");
  const clave = password ? String(password) : matricula;
  if (!clave || clave.length < 4) fail(400, "La matrícula (contraseña inicial) debe tener al menos 4 caracteres.");
  return {
    id: nuevoId(),
    nombre,
    usuario: normalize(nombre),
    matricula,
    rol,
    activo: true,
    debeCambiar: !password,
    creado: Date.now(),
    ...hashPassword(clave),
  };
}

function validarUnico(lista, u, idIgnorar) {
  if (lista.some((x) => x.id !== idIgnorar && x.usuario === u.usuario))
    fail(409, `Ya existe un usuario llamado "${u.nombre}".`);
  if (u.matricula && lista.some((x) => x.id !== idIgnorar && x.matricula && x.matricula === u.matricula))
    fail(409, `La matrícula ${u.matricula} ya está registrada.`);
}

function datosPlanta(b, actual = {}) {
  const p = {
    ...actual,
    nombre: texto(b.nombre ?? actual.nombre, 80),
    especie: texto(b.especie ?? actual.especie, 80),
    areaId: texto(b.areaId ?? actual.areaId, 40),
    cadaDias: Math.min(30, Math.max(1, parseInt(b.cadaDias ?? actual.cadaDias ?? 1, 10) || 1)),
    vecesSeco: Math.min(2, Math.max(0, parseInt(b.vecesSeco ?? actual.vecesSeco ?? 0, 10) || 0)),
    litros: b.litros === "" ? null : Number(b.litros ?? actual.litros) || null,
    sol: texto(b.sol ?? actual.sol, 40),
    cuidados: texto(b.cuidados ?? actual.cuidados, 600),
    activa: b.activa ?? actual.activa ?? true,
  };
  if (!p.nombre) fail(400, "La planta necesita un nombre.");
  return p;
}

// Cuenta de prueba: si no hay usuarios, se crea un administrador "test".
// Usuario: test · Contraseña: test1234 (o la de la variable TEST_ADMIN_PASSWORD)
async function asegurarCuentaPrueba() {
  if ((await usuarios()).length > 0) return;
  const u = crearUsuario({
    nombre: "Test",
    matricula: process.env.TEST_ADMIN_PASSWORD || "test1234",
    rol: "admin",
  });
  await guardarUsuarios([u]);
  if (!(await db.get("config/sanciones"))) await db.set("config/sanciones", SANCIONES_DEFAULT);
}

// ---------------------------------------------------------------- rutas
async function rutas(req, partes) {
  const m = req.method;
  const [r0, r1, r2] = partes;
  const ahora = ahoraLocal();
  await asegurarCuentaPrueba();

  // ---- públicas
  if (r0 === "estado" && m === "GET") {
    return json({ configurado: (await usuarios()).length > 0, ahora });
  }

  if (r0 === "configurar" && m === "POST") {
    if ((await usuarios()).length > 0) fail(409, "El sistema ya fue configurado.");
    const b = await body(req);
    if (!b.password || String(b.password).length < 6) fail(400, "La contraseña debe tener al menos 6 caracteres.");
    const u = crearUsuario({ nombre: b.nombre, matricula: b.matricula, rol: "admin", password: b.password });
    await guardarUsuarios([u]);
    await db.set("config/sanciones", SANCIONES_DEFAULT);
    return json({ token: await createToken(u), usuario: publico(u) });
  }

  if (r0 === "login" && m === "POST") {
    const b = await body(req);
    const clave = normalize(b.usuario);
    const lista = await usuarios();
    const u = lista.find((x) => x.activo !== false && (x.usuario === clave || (x.matricula && normalize(x.matricula) === clave)));
    if (!u || !checkPassword(b.password, u)) fail(401, "Usuario o contraseña incorrectos.");
    return json({ token: await createToken(u), usuario: publico(u) });
  }

  // ---- con sesión
  const yo = await sesion(req);

  if (r0 === "yo" && !r1 && m === "GET") return json({ usuario: publico(yo), ahora });

  if (r0 === "yo" && r1 === "password" && m === "POST") {
    const b = await body(req);
    if (!checkPassword(b.actual, yo)) fail(400, "La contraseña actual no es correcta.");
    if (!b.nueva || String(b.nueva).length < 6) fail(400, "La nueva contraseña debe tener al menos 6 caracteres.");
    const lista = await usuarios();
    const u = lista.find((x) => x.id === yo.id);
    Object.assign(u, hashPassword(b.nueva), { debeCambiar: false });
    await guardarUsuarios(lista);
    return json({ ok: true });
  }

  // ---- clima
  if (r0 === "clima" && m === "GET") return json(await obtenerClima());

  // ---- tareas del día (se generan automáticamente la primera vez que alguien entra)
  if (r0 === "hoy" && m === "GET") {
    const dia = await generarDia(ahora.fecha);
    let tareas = (await tareasDelDia(ahora.fecha)).map((t) => conEstado(t, ahora));
    const resumen = {
      total: tareas.length,
      hechas: tareas.filter((t) => t.estadoReal === "hecha").length,
      pendientes: tareas.filter((t) => t.estadoReal === "pendiente").length,
      incumplidas: tareas.filter((t) => t.estadoReal === "incumplida").length,
    };
    if (yo.rol === "estudiante") tareas = tareas.filter((t) => t.estudianteId === yo.id);
    tareas.sort((a, b) => a.turno.localeCompare(b.turno) || a.areaNombre.localeCompare(b.areaNombre));
    return json({ ahora, dia, tareas, resumen });
  }

  if (r0 === "dia" && r1 === "regenerar" && m === "POST") {
    exigir(yo, "admin", "encargado");
    const dia = await generarDia(ahora.fecha, { forzar: true });
    return json({ dia });
  }

  if (r0 === "dia" && r1 === "lluvia" && m === "POST") {
    exigir(yo, "admin", "encargado");
    return json({ canceladas: await marcarLluvia(ahora.fecha, yo.nombre) });
  }

  if (r0 === "tareas" && !r1 && m === "GET") {
    const u = new URL(req.url);
    const hasta = u.searchParams.get("hasta") || ahora.fecha;
    const desde = u.searchParams.get("desde") || sumarDias(hasta, -30);
    let lista = (await tareasRango(desde, hasta)).map((t) => conEstado(t, ahora));
    if (yo.rol === "estudiante") lista = lista.filter((t) => t.estudianteId === yo.id);
    const est = u.searchParams.get("estudiante");
    if (est && yo.rol !== "estudiante") lista = lista.filter((t) => t.estudianteId === est);
    lista.sort((a, b) => b.fecha.localeCompare(a.fecha) || a.turno.localeCompare(b.turno));
    return json({ tareas: lista });
  }

  if (r0 === "tareas" && r1 && r2) {
    const fecha = r1.slice(0, 10);
    const id = r1.slice(11);
    const t = await db.get(`tarea/${fecha}/${id}`);
    if (!t) fail(404, "Tarea no encontrada.");
    const propia = t.estudianteId === yo.id;

    if (r2 === "hecha" && m === "POST") {
      if (!propia) exigir(yo, "admin", "encargado");
      if (t.fecha !== ahora.fecha) fail(400, "Solo se pueden marcar las tareas de hoy.");
      if (estadoEfectivo(t, ahora) === "incumplida" && yo.rol === "estudiante")
        fail(400, "La hora límite ya pasó. Puedes enviar una justificación.");
      const b = await body(req);
      t.estado = "hecha";
      t.hechaEn = Date.now();
      t.horaHecha = ahora.hora;
      t.hechaPor = yo.nombre;
      t.nota = texto(b.nota, 300) || undefined;
      await db.set(claveTarea(t), t);
      await db.set(`riego/${t.plantaId}`, { fecha: t.fecha });
      return json({ tarea: conEstado(t, ahora) });
    }

    if (r2 === "justificar" && m === "POST") {
      if (!propia) fail(403, "Solo puedes justificar tus propias tareas.");
      const b = await body(req);
      const motivo = texto(b.motivo, 500);
      if (motivo.length < 5) fail(400, "Escribe el motivo con un poco más de detalle.");
      if (t.estado === "hecha") fail(400, "Esta tarea ya está hecha.");
      t.justificacion = { motivo, en: Date.now(), estado: "pendiente" };
      await db.set(claveTarea(t), t);
      return json({ tarea: conEstado(t, ahora) });
    }

    if (r2 === "resolver" && m === "POST") {
      exigir(yo, "admin");
      if (!t.justificacion) fail(400, "Esta tarea no tiene justificación.");
      const b = await body(req);
      t.justificacion.estado = b.aceptar ? "aceptada" : "rechazada";
      t.justificacion.resueltaPor = yo.nombre;
      t.justificacion.respuesta = texto(b.respuesta, 300) || undefined;
      if (b.aceptar) t.estado = "justificada";
      await db.set(claveTarea(t), t);
      return json({ tarea: conEstado(t, ahora) });
    }

    if (r2 === "reasignar" && m === "POST") {
      exigir(yo, "admin", "encargado");
      const b = await body(req);
      const est = (await usuarios()).find((x) => x.id === b.estudianteId && x.rol === "estudiante");
      if (!est) fail(400, "Estudiante no válido.");
      t.estudianteId = est.id;
      t.estudianteNombre = est.nombre;
      await db.set(claveTarea(t), t);
      return json({ tarea: conEstado(t, ahora) });
    }
  }

  // ---- zonas del área verde
  if (r0 === "areas") {
    let areas = await db.get("areas", []);
    if (m === "GET") return json({ areas });
    exigir(yo, "admin", "encargado");
    const b = await body(req);
    if (m === "POST" && !r1) {
      const nombre = texto(b.nombre, 80);
      if (!nombre) fail(400, "La zona necesita un nombre.");
      const a = { id: nuevoId(), nombre, descripcion: texto(b.descripcion, 300) };
      areas.push(a);
      await db.set("areas", areas);
      return json({ area: a });
    }
    const a = areas.find((x) => x.id === r1);
    if (!a) fail(404, "Zona no encontrada.");
    if (m === "PUT") {
      a.nombre = texto(b.nombre, 80) || a.nombre;
      a.descripcion = texto(b.descripcion, 300);
      await db.set("areas", areas);
      return json({ area: a });
    }
    if (m === "DELETE") {
      const plantas = await db.get("plantas", []);
      if (plantas.some((p) => p.areaId === a.id)) fail(400, "Primero mueve o elimina las plantas de esta zona.");
      await db.set("areas", areas.filter((x) => x.id !== a.id));
      return json({ ok: true });
    }
  }

  // ---- plantas y árboles
  if (r0 === "plantas") {
    const plantas = await db.get("plantas", []);
    if (m === "GET") {
      const conRiego = await Promise.all(
        plantas.map(async (p) => ({ ...p, ultimoRiego: (await db.get(`riego/${p.id}`))?.fecha || null }))
      );
      return json({ plantas: conRiego });
    }
    exigir(yo, "admin", "encargado");
    const b = await body(req);
    if (m === "POST" && r1 === "importar") {
      // Lista de plantas en JSON: [{nombre, especie, zona, cadaDias, vecesSeco, litros, sol, cuidados}]
      const areas = await db.get("areas", []);
      const items = Array.isArray(b.plantas) ? b.plantas : [];
      let n = 0;
      for (const it of items.slice(0, 500)) {
        let areaId = "";
        if (it.zona) {
          let a = areas.find((x) => normalize(x.nombre) === normalize(it.zona));
          if (!a) {
            a = { id: nuevoId(), nombre: texto(it.zona, 80), descripcion: "" };
            areas.push(a);
          }
          areaId = a.id;
        }
        plantas.push({ id: nuevoId(), ...datosPlanta({ ...it, areaId }) });
        n++;
      }
      await db.set("areas", areas);
      await db.set("plantas", plantas);
      return json({ importadas: n });
    }
    if (m === "POST" && !r1) {
      const p = { id: nuevoId(), ...datosPlanta(b) };
      plantas.push(p);
      await db.set("plantas", plantas);
      return json({ planta: p });
    }
    const i = plantas.findIndex((x) => x.id === r1);
    if (i < 0) fail(404, "Planta no encontrada.");
    if (m === "PUT") {
      plantas[i] = datosPlanta(b, plantas[i]);
      await db.set("plantas", plantas);
      return json({ planta: plantas[i] });
    }
    if (m === "DELETE") {
      plantas.splice(i, 1);
      await db.set("plantas", plantas);
      await db.del(`riego/${r1}`);
      return json({ ok: true });
    }
  }

  // ---- usuarios
  if (r0 === "usuarios") {
    exigir(yo, "admin", "encargado");
    const lista = await usuarios();
    const puedeTocar = (u) => yo.rol === "admin" || u.rol === "estudiante";
    if (m === "GET" && !r1) {
      const visibles = yo.rol === "admin" ? lista : lista.filter((u) => u.rol === "estudiante");
      return json({ usuarios: visibles.map(publico) });
    }
    const b = await body(req);
    if (m === "POST" && r1 === "importar") {
      // Un estudiante por línea: "Nombre completo, matrícula"
      const lineas = String(b.texto || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const creados = [];
      const errores = [];
      for (const linea of lineas.slice(0, 300)) {
        const partes = linea.split(/[,;\t]/).map((s) => s.trim()).filter(Boolean);
        const matricula = partes.length > 1 ? partes.pop() : "";
        const nombre = partes.join(" ");
        try {
          const u = crearUsuario({ nombre, matricula, rol: "estudiante" });
          validarUnico(lista, u);
          lista.push(u);
          creados.push(u.nombre);
        } catch (e) {
          errores.push(`${linea}: ${e.message}`);
        }
      }
      await guardarUsuarios(lista);
      return json({ creados, errores });
    }
    if (m === "POST" && !r1) {
      const rol = b.rol || "estudiante";
      if (yo.rol !== "admin" && rol !== "estudiante") fail(403, "Solo el administrador crea otros perfiles.");
      const u = crearUsuario({ nombre: b.nombre, matricula: b.matricula, rol });
      validarUnico(lista, u);
      lista.push(u);
      await guardarUsuarios(lista);
      return json({ usuario: publico(u) });
    }
    const u = lista.find((x) => x.id === r1);
    if (!u) fail(404, "Usuario no encontrado.");
    if (!puedeTocar(u)) fail(403, "No puedes modificar este perfil.");
    if (u.id === yo.id && (m === "DELETE" || (b.activo === false) || (b.rol && b.rol !== yo.rol)))
      fail(400, "No puedes desactivar ni cambiar el rol de tu propia cuenta.");
    if (m === "POST" && r2 === "restablecer") {
      if (!u.matricula) fail(400, "Este usuario no tiene matrícula registrada.");
      Object.assign(u, hashPassword(u.matricula), { debeCambiar: true });
      await guardarUsuarios(lista);
      return json({ ok: true });
    }
    if (m === "PUT") {
      if (b.nombre) {
        u.nombre = texto(b.nombre, 80);
        u.usuario = normalize(u.nombre);
      }
      if (b.matricula !== undefined) u.matricula = texto(b.matricula, 30);
      if (b.rol && yo.rol === "admin" && ROLES.includes(b.rol)) u.rol = b.rol;
      if (typeof b.activo === "boolean") u.activo = b.activo;
      validarUnico(lista, u, u.id);
      await guardarUsuarios(lista);
      return json({ usuario: publico(u) });
    }
    if (m === "DELETE") {
      await guardarUsuarios(lista.filter((x) => x.id !== u.id));
      return json({ ok: true });
    }
  }

  // ---- panel del administrador
  if (r0 === "admin" && r1 === "resumen" && m === "GET") {
    exigir(yo, "admin");
    const u = new URL(req.url);
    const dias = Math.min(120, Math.max(1, parseInt(u.searchParams.get("dias") || "30", 10)));
    const tareas = (await tareasRango(sumarDias(ahora.fecha, -dias), ahora.fecha)).map((t) => conEstado(t, ahora));
    const sanciones = await todasSanciones();
    const estudiantes = (await usuarios()).filter((x) => x.rol === "estudiante");
    const filas = estudiantes.map((e) => {
      const mias = tareas.filter((t) => t.estudianteId === e.id && t.estadoReal !== "lluvia");
      const cerradas = mias.filter((t) => t.estadoReal !== "pendiente");
      const hechas = mias.filter((t) => t.estadoReal === "hecha").length;
      return {
        id: e.id,
        nombre: e.nombre,
        matricula: e.matricula,
        activo: e.activo !== false,
        asignadas: mias.length,
        hechas,
        incumplidas: mias.filter((t) => t.estadoReal === "incumplida" && t.justificacion?.estado !== "pendiente").length,
        justificadas: mias.filter((t) => t.estadoReal === "justificada").length,
        cumplimiento: cerradas.length ? Math.round((hechas / cerradas.length) * 100) : null,
        sancionesActivas: sanciones.filter((s) => s.estudianteId === e.id && s.estado === "asignada").length,
      };
    });
    const sancionadas = new Set(sanciones.flatMap((s) => s.tareaIds || []));
    return json({
      dias,
      estudiantes: filas.sort((a, b) => b.incumplidas - a.incumplidas || a.nombre.localeCompare(b.nombre, "es")),
      justificacionesPendientes: tareas.filter((t) => t.justificacion?.estado === "pendiente"),
      incumplidas: tareas.filter(
        (t) => t.estadoReal === "incumplida" && t.justificacion?.estado !== "pendiente" && !sancionadas.has(`${t.fecha}_${t.id}`)
      ),
    });
  }

  // ---- sanciones
  if (r0 === "sanciones") {
    if (r1 === "catalogo") {
      let cat = await db.get("config/sanciones", SANCIONES_DEFAULT);
      if (m === "GET") return json({ catalogo: cat });
      exigir(yo, "admin");
      const b = await body(req);
      if (m === "POST") {
        const nombre = texto(b.nombre, 80);
        if (!nombre) fail(400, "La sanción necesita un nombre.");
        const s = { id: nuevoId(), nombre, descripcion: texto(b.descripcion, 300), nivel: Number(b.nivel) || cat.length + 1 };
        cat.push(s);
        await db.set("config/sanciones", cat);
        return json({ sancion: s });
      }
      if (m === "DELETE" && r2) {
        cat = cat.filter((s) => s.id !== r2);
        await db.set("config/sanciones", cat);
        return json({ ok: true });
      }
    }
    if (m === "GET" && !r1) {
      let lista = await todasSanciones();
      if (yo.rol === "estudiante") lista = lista.filter((s) => s.estudianteId === yo.id);
      else exigir(yo, "admin");
      return json({ sanciones: lista.sort((a, b) => b.en - a.en) });
    }
    exigir(yo, "admin");
    const b = await body(req);
    if (m === "POST" && !r1) {
      const cat = await db.get("config/sanciones", SANCIONES_DEFAULT);
      const c = cat.find((x) => x.id === b.catalogoId);
      if (!c) fail(400, "Elige una sanción del catálogo.");
      const est = (await usuarios()).find((x) => x.id === b.estudianteId && x.rol === "estudiante");
      if (!est) fail(400, "Estudiante no válido.");
      const s = {
        id: nuevoId(),
        estudianteId: est.id,
        estudianteNombre: est.nombre,
        catalogoId: c.id,
        nombre: c.nombre,
        descripcion: c.descripcion,
        tareaIds: Array.isArray(b.tareaIds) ? b.tareaIds.slice(0, 50).map(String) : [],
        nota: texto(b.nota, 400),
        estado: "asignada",
        asignadaPor: yo.nombre,
        en: Date.now(),
        fecha: ahora.fecha,
      };
      await db.set(`sancion/${s.id}`, s);
      return json({ sancion: s });
    }
    if (m === "POST" && r1 && r2 === "cumplida") {
      const s = await db.get(`sancion/${r1}`);
      if (!s) fail(404, "Sanción no encontrada.");
      s.estado = "cumplida";
      s.cumplidaEn = ahora.fecha;
      await db.set(`sancion/${s.id}`, s);
      return json({ sancion: s });
    }
    if (m === "DELETE" && r1) {
      await db.del(`sancion/${r1}`);
      return json({ ok: true });
    }
  }

  // ---- ajustes
  if (r0 === "ajustes") {
    if (m === "GET") return json({ ajustes: await getAjustes() });
    exigir(yo, "admin", "encargado");
    if (m === "PUT") {
      const b = await body(req);
      const a = await getAjustes();
      const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
      const hora = (v, d) => (/^\d{2}:\d{2}$/.test(v || "") ? v : d);
      const nuevo = {
        lugar: texto(b.lugar, 80) || a.lugar,
        lat: num(b.lat, a.lat),
        lon: num(b.lon, a.lon),
        umbralLluviaMm: num(b.umbralLluviaMm, a.umbralLluviaMm),
        umbralLluviaAyerMm: num(b.umbralLluviaAyerMm, a.umbralLluviaAyerMm),
        umbralCalorC: num(b.umbralCalorC, a.umbralCalorC),
        diasActivos: Array.isArray(b.diasActivos)
          ? [...new Set(b.diasActivos.map(Number).filter((d) => d >= 0 && d <= 6))]
          : a.diasActivos,
        limiteManana: hora(b.limiteManana, a.limiteManana),
        limiteTarde: hora(b.limiteTarde, a.limiteTarde),
      };
      await db.set("config/ajustes", nuevo);
      await db.del("clima/cache");
      return json({ ajustes: { ...AJUSTES_DEFAULT, ...nuevo } });
    }
  }

  fail(404, "Ruta no encontrada.");
}

async function todasSanciones() {
  return (await db.getMany(await db.list("sancion/"))).filter(Boolean);
}

export default async function handler(req) {
  try {
    const partes = new URL(req.url).pathname.replace(/^\/(\.netlify\/functions\/)?api\/?/, "").split("/").filter(Boolean);
    return await rutas(req, partes);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "Error interno del servidor." }, 500);
  }
}
