# Área Verde UPT

Sistema web para el mantenimiento del área verde (Ética Profesional, UPT, grupo 403).
Organiza los turnos de riego entre los estudiantes, los ajusta al clima real de Tulancingo
y le da al jefe de grupo o tutor un panel para dar seguimiento y aplicar sanciones.

## Perfiles

| Perfil | Quién | Qué ve |
| --- | --- | --- |
| **Super admin** | Responsable del sistema (la cuenta `test` al inicio) | Todo lo del administrador, y además puede quitar o cambiar administradores |
| **Administrador** | Jefe de grupo o tutor | Panel de cumplimiento, justificaciones, sanciones, usuarios, plantas y ajustes. Puede agregar admins, pero no quitarlos |
| **Encargado** | Equipo de mantenimiento | Turnos de hoy, zonas y plantas, estudiantes, ajustes del clima |
| **Estudiante** | Los ~30 participantes | Sus tareas del día, su historial y sus sanciones (privadas) |

**Inicio de sesión:** usuario = nombre completo (o matrícula), contraseña inicial = matrícula.
Cada quien puede cambiar su contraseña en *Mi cuenta*.

**Equipo de mantenimiento:** Joshua, Fabricio, Jesús Ernesto y Marcos Roberto ya vienen registrados como encargados.
Entran con su nombre completo y la contraseña temporal `areaverde` (la app les pide cambiarla).

## Notificaciones en el celular

La app se puede instalar en la pantalla de inicio y manda avisos aunque esté cerrada:

- cuando a un estudiante le toca regar,
- un recordatorio 1 hora antes de la hora límite,
- un aviso si el turno quedó sin registrar (para que pueda justificarlo),
- cuando le reasignan un turno.

Cada vez que alguien abre la app sin notificaciones, se le vuelve a pedir que las active.
Una función programada de Netlify revisa los turnos cada 15 minutos. Las llaves de las notificaciones se crean solas.

- **Android (Chrome):** se activan directo desde la app.
- **iPhone:** primero hay que agregar la app a la pantalla de inicio (Compartir → Agregar a inicio) y abrirla desde el ícono;
  Apple solo permite notificaciones web así (iOS 16.4 o más reciente).

## Cómo funciona el riego con el clima

Cada mañana, la primera vez que alguien entra, el sistema consulta el clima (Open-Meteo, gratis y sin clave) y decide:

- **Lluvia** (se pronostican ≥ 5 mm hoy, o ayer llovieron ≥ 10 mm): no se generan riegos.
- **Seco y caluroso** (máxima ≥ 28 °C sin lluvia): las plantas marcadas así se riegan 1 o 2 veces al día.
- **Normal:** cada planta se riega según su frecuencia (cada N días desde su último riego).

Los turnos se reparten de forma rotativa entre los estudiantes activos. Si a la hora límite un turno no se marcó
como hecho, queda como *no cumplido*; el estudiante puede justificarlo y el administrador decide.
Todos los umbrales y horarios se cambian en *Clima y horarios*.

## Publicar en Netlify

1. En Netlify: **Add new site → Import an existing project → GitHub** y elige este repositorio.
2. No hace falta comando de build. Netlify lee `netlify.toml` (carpeta `public` y funciones en `netlify/functions`).
3. Publica y entra con la **cuenta de prueba**: usuario `test`, contraseña `test1234`.
   Desde ahí crea las cuentas reales (administrador, encargados y estudiantes).
   Después, cambia la contraseña de `test` en *Mi cuenta* o desactívala desde otra cuenta de administrador,
   porque cualquiera que conozca esos datos podría entrar como administrador.
   (Puedes definir otra contraseña inicial con la variable `TEST_ADMIN_PASSWORD` antes del primer uso.)
4. (Recomendado) En *Site configuration → Environment variables* agrega `AUTH_SECRET` con un texto largo y aleatorio.

Los datos se guardan en **Netlify Blobs**, incluido gratis, sin configurar una base de datos aparte.

## Probar en tu computadora

```bash
npm install
npm run dev     # http://localhost:8888  (los datos se guardan en .data/)
```

## Estructura

```
public/                 Interfaz (HTML, CSS y JavaScript)
netlify/functions/api.mjs   API: /api/*
netlify/lib/            Clima, turnos, sesiones y almacenamiento
dev-server.mjs          Servidor local de pruebas
```
