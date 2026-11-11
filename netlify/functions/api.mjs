// API del sistema de mantenimiento del área verde.
// Todas las rutas viven bajo /api/*
import * as db from "../lib/store.mjs";
import { checkPassword, createToken, hashPassword, normalize, readToken } from "../lib/auth.mjs";
import { AJUSTES_DEFAULT, ahoraLocal, getAjustes, obtenerClima, sumarDias } from "../lib/clima.mjs";
import {
  claveTarea, conEstado, estadoEfectivo, generarDia, marcarLluvia, nuevoId,
  tareasDelDia, tareasRango, usuarios,
} from "../lib/tareas.mjs";
import { clavePublica, desuscribir, enviarA, suscribir, tieneSuscripcion } from "../lib/push.mjs";
import * as encuesta from "../lib/encuesta.mjs";

export const config = { path: "/api/*" };

const ROLES = ["superadmin", "admin", "encargado", "docente", "estudiante"];
const esAdmin = (u) => u.rol === "admin" || u.rol === "superadmin";
const rolesAsignables = (rol) =>
  rol === "superadmin" ? ROLES
  : rol === "admin" ? ["admin", "encargado", "docente", "estudiante"]
  : rol === "encargado" ? ["estudiante"]
  : [];
// Los docentes solo consultan los resultados del cuestionario; no ven turnos ni datos de estudiantes
const veTurnos = (u) => u.rol !== "docente";

// Usuario = nombre completo sin espacios. Al iniciar sesión no importan mayúsculas, acentos ni espacios.
const sinEspacios = (s) => String(s || "").replace(/\s+/g, "");
const claveUsuario = (s) => normalize(s).replace(/\s+/g, "");

// Estudiantes que se registran una sola vez (contraseña inicial = matrícula)
const ESTUDIANTES_INICIALES = [
  ["María Guadalupe Alarcon Santos", "2534415"],
  ["Neidy Emireth Mejia Santos", "2534541"],
  ["Erika Rubí Vargas Jacobo", "2530953"],
  ["Yessenia Ximena Salinas Cordero", "2530963"],
  ["América Isabel Martinez Islas", "2530883"],
];

// Equipo de mantenimiento: se registra una sola vez como encargados.
// Como aún no tienen matrícula registrada, su contraseña temporal es "areaverde".
const EQUIPO = [
  "Joshua Dylan Caro Lemus",
  "Fabricio Guajardo Soto",
  "Jesus Ernesto Romero Hernandez",
  "Marcos Roberto Tolentino Diaz",
];
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
// El super admin tiene todos los permisos del admin
const exigir = (u, ...roles) => {
  const rol = u.rol === "superadmin" ? "admin" : u.rol;
  if (!roles.includes(rol)) fail(403, "No tienes permiso para esta acción.");
};

// Todos los cambios a usuarios pasan por aquí: se lee la lista más reciente, se modifica y se guarda
// solo si nadie más la cambió en ese momento (si no, se repite). Así no se pierden contraseñas ni ediciones.
function actualizarUsuarios(cambiar) {
  return db.actualizar("usuarios", [], cambiar);
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
    usuario: sinEspacios(nombre),
    matricula,
    rol,
    activo: true,
    debeCambiar: !password,
    creado: Date.now(),
    ...hashPassword(clave),
  };
}

function validarUnico(lista, u, idIgnorar) {
  const otros = lista.filter((x) => x.id !== idIgnorar);
  const k = claveUsuario(u.usuario);
  // El usuario tampoco puede ser igual a la matrícula de otra persona, porque también sirve para entrar
  if (otros.some((x) => claveUsuario(x.usuario) === k || (x.matricula && claveUsuario(x.matricula) === k)))
    fail(409, `El usuario "${u.usuario}" ya está en uso.`);
  if (u.matricula && otros.some((x) => (x.matricula && x.matricula === u.matricula) || claveUsuario(x.usuario) === claveUsuario(u.matricula)))
    fail(409, `La matrícula ${u.matricula} ya está registrada.`);
}

function validarFormatoUsuario(v) {
  const s = texto(v, 60);
  if (/\s/.test(s)) fail(400, "El usuario no puede llevar espacios.");
  if (s.length < 3 || s.length > 40) fail(400, "El usuario debe tener entre 3 y 40 caracteres.");
  if (!/^[\p{L}\p{N}._-]+$/u.test(s)) fail(400, "El usuario solo puede llevar letras, números, punto, guion y guion bajo.");
  return s;
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
let semillaLista = false;
async function asegurarCuentaPrueba() {
  if (semillaLista) return;
  const semillaEquipo = !(await db.get("config/semilla-equipo"));
  const semillaEst = !(await db.get("config/semilla-estudiantes-1"));
  const repararClaves = !(await db.get("config/reparacion-claves-1"));
  // Se hace dentro de actualizarUsuarios para no pisar un cambio que alguien guarde al mismo tiempo
  await actualizarUsuarios((lista) => revisarSemillas(lista, { semillaEquipo, semillaEst, repararClaves }));
  if (semillaEquipo) await db.set("config/semilla-equipo", true);
  if (repararClaves) await db.set("config/reparacion-claves-1", true);
  if (semillaEst) await db.set("config/semilla-estudiantes-1", true);
  if (!(await db.get("config/sanciones"))) await db.set("config/sanciones", SANCIONES_DEFAULT);
  semillaLista = true;
}

// Devuelve false si no hubo nada que cambiar (así no se escribe la lista en cada arranque)
function revisarSemillas(lista, { semillaEquipo, semillaEst, repararClaves }) {
  let cambio = false;
  // Reparación (una vez): a los encargados y administradores que se les agregó matrícula pero seguían con la
  // contraseña temporal "areaverde", su contraseña pasa a ser la matrícula, como dice la pantalla.
  if (repararClaves) {
    for (const u of lista) {
      if (u.rol === "estudiante" || !u.debeCambiar || !u.matricula || u.matricula.length < 4) continue;
      if (!checkPassword("areaverde", u)) continue;
      Object.assign(u, hashPassword(u.matricula), { claveTemporal: false });
      cambio = true;
    }
  }
  if (lista.length === 0) {
    lista.push(
      crearUsuario({ nombre: "Test", matricula: process.env.TEST_ADMIN_PASSWORD || "test1234", rol: "superadmin" })
    );
    cambio = true;
  }
  // Si ya existía la cuenta de prueba como admin, se convierte en super admin
  if (!lista.some((u) => u.rol === "superadmin")) {
    const primero = lista.filter((u) => u.rol === "admin").sort((a, b) => a.creado - b.creado)[0];
    if (primero) {
      primero.rol = "superadmin";
      cambio = true;
    }
  }
  if (semillaEquipo) {
    for (const nombre of EQUIPO) {
      if (lista.some((u) => claveUsuario(u.usuario) === claveUsuario(nombre))) continue;
      const u = crearUsuario({ nombre, matricula: "", rol: "encargado", password: "areaverde" });
      u.debeCambiar = true;
      u.claveTemporal = true;
      lista.push(u);
    }
    cambio = true;
  }
  // Antes el usuario era el nombre con espacios; ahora es el nombre sin espacios
  for (const u of lista) {
    if (!u.usuarioPropio && /\s/.test(u.usuario || "")) {
      u.usuario = sinEspacios(u.nombre);
      cambio = true;
    }
  }
  if (semillaEst) {
    for (const [nombre, matricula] of ESTUDIANTES_INICIALES) {
      const k = claveUsuario(nombre);
      if (lista.some((u) => u.matricula === matricula || claveUsuario(u.usuario) === k)) continue;
      lista.push(crearUsuario({ nombre, matricula, rol: "estudiante" }));
    }
    cambio = true;
  }
  return cambio;
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
    await actualizarUsuarios((lista) => {
      if (lista.length > 0) fail(409, "El sistema ya fue configurado.");
      lista.push(u);
    });
    await db.set("config/sanciones", SANCIONES_DEFAULT);
    return json({ token: await createToken(u), usuario: publico(u) });
  }

  if (r0 === "login" && m === "POST") {
    const b = await body(req);
    const clave = claveUsuario(b.usuario);
    if (!clave) fail(401, "Usuario o contraseña incorrectos.");
    const lista = await usuarios();
    // Se revisan todas las cuentas que coinciden (por usuario o por matrícula), no solo la primera
    const u = lista
      .filter((x) => x.activo !== false && (claveUsuario(x.usuario) === clave || (x.matricula && claveUsuario(x.matricula) === clave)))
      .find((x) => checkPassword(b.password, x));
    if (!u) fail(401, "Usuario o contraseña incorrectos.");
    return json({ token: await createToken(u), usuario: publico(u) });
  }

  // ---- sección pública para visitantes (sin sesión)
  if (r0 === "encuesta" && r1 === "preguntas" && m === "GET") {
    return json({ preguntas: encuesta.PREGUNTAS, version: encuesta.VERSION });
  }

  if (r0 === "encuesta" && r1 === "respuestas" && m === "POST") {
    const b = await body(req);
    // Campo trampa: las personas no lo ven, los programas automáticos lo llenan
    if (b.sitio) return json({ ok: true });
    if (Number(b.ms) > 0 && Number(b.ms) < 4000) fail(400, "Tómate un momento para leer las preguntas.");
    const v = encuesta.validar(b.respuestas);
    if (v.error) fail(400, v.error);
    await encuesta.guardar(v.respuestas, ahora.fecha);
    return json({ ok: true });
  }

  if (r0 === "publico" && r1 === "area" && m === "GET") {
    const [areas, plantas, clima] = await Promise.all([db.get("areas", []), db.get("plantas", []), obtenerClima().catch(() => null)]);
    const activas = plantas.filter((p) => p.activa !== false);
    return json({
      zonas: areas.map((a) => ({
        nombre: a.nombre,
        descripcion: a.descripcion || "",
        plantas: activas.filter((p) => p.areaId === a.id).map((p) => ({ nombre: p.nombre, especie: p.especie || "", sol: p.sol || "" })),
      })),
      totalPlantas: activas.length,
      clima: clima?.disponible
        ? { lugar: clima.lugar, actual: clima.actual, hoy: clima.hoy, decision: clima.decision }
        : null,
    });
  }

  // ---- con sesión
  const yo = await sesion(req);

  if (r0 === "yo" && !r1 && m === "GET") return json({ usuario: publico(yo), ahora });

  // Cada quien puede cambiar su propio usuario (pide la contraseña para confirmar)
  if (r0 === "yo" && r1 === "usuario" && m === "POST") {
    const b = await body(req);
    if (!checkPassword(b.password, yo)) fail(400, "La contraseña no es correcta.");
    const nuevo = validarFormatoUsuario(b.usuario);
    const u = await actualizarUsuarios((lista) => {
      const u = lista.find((x) => x.id === yo.id);
      if (!u) fail(404, "Usuario no encontrado.");
      u.usuario = nuevo;
      u.usuarioPropio = true;
      validarUnico(lista, u, u.id);
      return u;
    });
    return json({ usuario: publico(u) });
  }

  if (r0 === "yo" && r1 === "password" && m === "POST") {
    const b = await body(req);
    if (!checkPassword(b.actual, yo)) fail(400, "La contraseña actual no es correcta.");
    if (!b.nueva || String(b.nueva).length < 6) fail(400, "La nueva contraseña debe tener al menos 6 caracteres.");
    const nueva = hashPassword(b.nueva);
    await actualizarUsuarios((lista) => {
      const u = lista.find((x) => x.id === yo.id);
      if (!u) fail(404, "Usuario no encontrado.");
      Object.assign(u, nueva, { debeCambiar: false, claveTemporal: false, claveAsignada: false });
    });
    return json({ ok: true });
  }

  // ---- notificaciones
  if (r0 === "push") {
    if (r1 === "clave" && m === "GET")
      return json({ clave: await clavePublica(), suscrito: await tieneSuscripcion(yo.id) });
    const b = await body(req);
    if (r1 === "suscribir" && m === "POST") {
      try {
        await suscribir(yo.id, b.suscripcion);
      } catch (e) {
        fail(400, e.message);
      }
      return json({ ok: true });
    }
    if (r1 === "quitar" && m === "POST") {
      if (b.endpoint) await desuscribir(yo.id, b.endpoint);
      return json({ ok: true });
    }
    if (r1 === "prueba" && m === "POST") {
      const n = await enviarA(yo.id, {
        titulo: "¡Notificaciones activadas! 🌱",
        cuerpo: "Así te avisaremos cuando te toque regar.",
        etiqueta: "prueba",
      });
      return json({ enviados: n });
    }
  }

  // ---- clima
  if (r0 === "clima" && m === "GET") return json(await obtenerClima());

  // ---- tareas del día (se generan automáticamente la primera vez que alguien entra)
  if ((r0 === "hoy" || r0 === "tareas" || r0 === "dia") && !veTurnos(yo)) fail(403, "Tu perfil no tiene acceso a los turnos.");

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
      if (t.fecha === ahora.fecha && t.estado === "pendiente") {
        await enviarA(est.id, {
          titulo: "Te asignaron un turno de riego 🌱",
          cuerpo: `${t.plantaNombre} (${t.areaNombre}) · antes de las ${t.limite}.`,
          etiqueta: `${t.id}-reasignada`,
        }).catch(() => {});
      }
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
    // Qué perfiles puede crear/asignar cada quien
    const asignables = rolesAsignables(yo.rol);
    // A quién puede modificar: super admin a todos; admin a encargados y estudiantes; encargado a estudiantes
    const puedeTocar = (u) =>
      yo.rol === "superadmin" || (yo.rol === "admin" ? ["encargado", "docente", "estudiante"].includes(u.rol) : u.rol === "estudiante");
    if (m === "GET" && !r1) {
      const visibles = esAdmin(yo) ? lista : lista.filter((u) => u.rol === "estudiante");
      return json({ usuarios: visibles.map(publico), asignables });
    }
    const b = await body(req);
    if (m === "POST" && r1 === "importar") {
      // Un estudiante por línea: "Nombre completo, matrícula"
      const lineas = String(b.texto || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 300);
      const nuevos = lineas.map((linea) => {
        const partes = linea.split(/[,;\t]/).map((s) => s.trim()).filter(Boolean);
        const matricula = partes.length > 1 ? partes.pop() : "";
        try {
          return { linea, u: crearUsuario({ nombre: partes.join(" "), matricula, rol: "estudiante" }) };
        } catch (e) {
          return { linea, error: e.message };
        }
      });
      let creados = [];
      let errores = [];
      await actualizarUsuarios((lista) => {
        creados = [];
        errores = [];
        for (const n of nuevos) {
          if (n.error) {
            errores.push(`${n.linea}: ${n.error}`);
            continue;
          }
          try {
            validarUnico(lista, n.u);
            lista.push(n.u);
            creados.push(n.u.nombre);
          } catch (e) {
            errores.push(`${n.linea}: ${e.message}`);
          }
        }
        // Si no se creó nadie, no se escribe la lista
        return creados.length > 0;
      });
      return json({ creados, errores });
    }
    if (m === "POST" && !r1) {
      const rol = b.rol || "estudiante";
      if (!asignables.includes(rol)) fail(403, "No puedes crear usuarios con ese perfil.");
      const u = crearUsuario({ nombre: b.nombre, matricula: b.matricula, rol });
      await actualizarUsuarios((lista) => {
        validarUnico(lista, u);
        lista.push(u);
      });
      return json({ usuario: publico(u) });
    }

    // Revisa permisos sobre la versión más reciente de la lista
    const revisar = (lista) => {
      const u = lista.find((x) => x.id === r1);
      if (!u) fail(404, "Usuario no encontrado.");
      if (!puedeTocar(u)) fail(403, "No puedes modificar este perfil.");
      if (u.id === yo.id && (m === "DELETE" || b.activo === false || (b.rol && b.rol !== yo.rol)))
        fail(400, "No puedes desactivar ni cambiar el rol de tu propia cuenta.");
      if (b.rol && b.rol !== u.rol && !asignables.includes(b.rol)) fail(403, "No puedes asignar ese perfil.");
      // Siempre debe quedar al menos un super admin activo
      const quitaSuper = u.rol === "superadmin" && (m === "DELETE" || b.activo === false || (b.rol && b.rol !== "superadmin"));
      if (quitaSuper && lista.filter((x) => x.rol === "superadmin" && x.activo !== false).length <= 1)
        fail(400, "Debe quedar al menos un super admin.");
      return u;
    };
    // El hash se calcula fuera para no repetirlo si hay que reintentar el guardado
    const nuevaClave = b.password ? String(b.password) : "";
    if (m === "PUT" && nuevaClave && nuevaClave.length < 4) fail(400, "La contraseña debe tener al menos 4 caracteres.");
    const hashNueva = nuevaClave ? hashPassword(nuevaClave) : null;
    const nuevaMatricula = b.matricula !== undefined ? texto(b.matricula, 30) : undefined;
    const hashMatricula = nuevaMatricula && nuevaMatricula.length >= 4 ? hashPassword(nuevaMatricula) : null;

    if (m === "POST" && r2 === "restablecer") {
      await actualizarUsuarios((lista) => {
        const u = revisar(lista);
        if (!u.matricula) fail(400, "Este usuario no tiene matrícula registrada.");
        Object.assign(u, hashPassword(u.matricula), { debeCambiar: true, claveTemporal: false, claveAsignada: false });
      });
      return json({ ok: true, aviso: "La contraseña ahora es la matrícula." });
    }
    if (m === "PUT") {
      const r = await actualizarUsuarios((lista) => {
        const u = revisar(lista);
        const usuarioAntes = u.usuario;
        const matriculaAntes = u.matricula || "";
        let aviso = "";
        if (b.nombre) {
          u.nombre = texto(b.nombre, 80);
          // Si la persona no ha elegido su propio usuario, se actualiza con el nombre nuevo
          if (!u.usuarioPropio) u.usuario = sinEspacios(u.nombre);
        }
        if (b.usuario && b.usuario !== usuarioAntes) {
          u.usuario = validarFormatoUsuario(b.usuario);
          u.usuarioPropio = true;
        }
        if (nuevaMatricula !== undefined) u.matricula = nuevaMatricula;
        if (b.rol && ROLES.includes(b.rol)) u.rol = b.rol;
        if (typeof b.activo === "boolean") u.activo = b.activo;
        validarUnico(lista, u, u.id);
        if (hashNueva) {
          // El administrador le asigna una contraseña; se le pedirá cambiarla al entrar
          Object.assign(u, hashNueva, { debeCambiar: true, claveTemporal: false, claveAsignada: true });
          aviso = "Contraseña actualizada.";
        } else if (hashMatricula && u.matricula !== matriculaAntes && u.debeCambiar) {
          // Si todavía usaba su contraseña inicial (o la temporal "areaverde"), pasa a ser la matrícula nueva
          Object.assign(u, hashMatricula, { claveTemporal: false, claveAsignada: false });
          aviso = "Como aún usaba su contraseña inicial, ahora su contraseña es la matrícula.";
        }
        return { u, aviso };
      });
      return json({ usuario: publico(r.u), aviso: r.aviso });
    }
    if (m === "DELETE") {
      await actualizarUsuarios((lista) => {
        const u = revisar(lista);
        lista.splice(lista.indexOf(u), 1);
      });
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

  // ---- resultados del cuestionario (administradores y docentes)
  if (r0 === "encuesta") {
    exigir(yo, "admin", "docente");
    if (r1 === "resultados" && m === "GET") {
      const u = new URL(req.url);
      const periodo = u.searchParams.get("periodo") || "todo";
      const carrera = texto(u.searchParams.get("carrera"), 40);
      const desde =
        periodo === "hoy" ? ahora.fecha
        : periodo === "7" ? sumarDias(ahora.fecha, -6)
        : periodo === "30" ? sumarDias(ahora.fecha, -29)
        : null;
      const lista = await encuesta.todas();
      const fechas = Array.from({ length: 14 }, (_, i) => sumarDias(ahora.fecha, i - 13));
      const deCarrera = carrera ? lista.filter((d) => d.r?.q1 === carrera) : lista;
      return json({
        ...encuesta.resumir(lista, { desde, carrera }),
        totalGeneral: lista.length,
        hoy: lista.filter((d) => d.fecha === ahora.fecha).length,
        porDia: encuesta.porDia(deCarrera, fechas),
        periodo,
        carrera,
        ahora,
      });
    }
    if (r1 === "exportar" && m === "GET") {
      const lista = await encuesta.todas();
      return json({ preguntas: encuesta.PREGUNTAS, respuestas: lista.map(({ en, fecha, r }) => ({ en, fecha, r })) });
    }
    if (r1 === "respuestas" && m === "DELETE") {
      exigir(yo, "admin");
      return json({ borradas: await encuesta.borrarTodas() });
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
