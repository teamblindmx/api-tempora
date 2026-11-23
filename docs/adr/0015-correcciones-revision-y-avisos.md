# ADR 0015: Corrección de horas, revisión de jornadas y avisos al líder

- Estado: propuesta
- Fecha: 2026-11-23

## Contexto

Semana 7 del plan, lo que faltaba de la jornada antes del piloto de mediados de diciembre: la regla 13
pide que todo ajuste guarde autor, fecha, valor anterior y valor nuevo; las reglas 3 y 8 dejan
jornadas "por revisar" que nadie podía dar por revisadas; y la regla 8 dice que se avisa al líder. El
marcado manual (ADR 0013) solo agrega lo que falta: no había forma de arreglar una hora mal
registrada. Las notificaciones push quedan para después del 1 de enero.

## Decisión

**Corrección de horas.** `POST /sites/:siteId/attendance/records/:id/correct` con `checkInAt` y/o
`checkOutAt` y `comment` obligatorio. Permiso `attendance:correct` (líder y administradores; el
encargado no). Reglas (`rules/correction.ts`):

- Hasta **31 días** atrás (un periodo de nómina largo), nunca en el futuro, jornadas de máximo 24 h,
  salida no antes de la entrada.
- La entrada corregida queda en el **mismo día de jornada**: mover una jornada de día no es corregir.
- Solo se corrige una salida que **existe**; agregar una salida que falta es `manual/check-out`.
- Nadie corrige la suya (también lo impide un CHECK). Una corrección que no cambia nada es 422.
- Con la hora nueva se vuelven a decidir el **retardo** (con el horario y la tolerancia actuales de la
  sede), el **tipo de salida** y la regla 8 (**fuera de horario**). Si queda como salida anticipada y
  no tenía motivo, el comentario de la corrección es el motivo (regla 6). Los motivos de ubicación no
  cambian: la corrección no mueve dónde marcó. El origen (`self`/`manual`) tampoco: dice quién marcó.
- Cada corrección se guarda en `attendance_correction` (solo inserción): entrada y salida antes y
  después, quién, cuándo y por qué. La jornada trae `correctedAt`/`correctedBy` de la última, y
  `GET .../records/:id` devuelve la jornada con todo su historial. También va a la auditoría.
- Concurrencia: la actualización exige que las horas sigan siendo las que se leyeron; si alguien más
  la cambió, 409 `TEMPORA_RECORD_CHANGED`.

**Revisión.** `POST .../records/:id/review` (`attendance:correct`, `comment` opcional). Los motivos
(`reviewReasons`) no se borran: son evidencia. Revisar copia los motivos actuales a
`reviewedReasons`, con quién, cuándo y el comentario. `needsReview` es "hay un motivo sin revisar":
si la salida agrega uno después de revisar la entrada, la jornada vuelve a la lista. Si una corrección
quita "fuera de horario", su revisión se quita con él. `GET .../attendance/review` lista lo pendiente
(último mes por omisión) con la persona; el encargado la puede ver. Nadie revisa la suya.

**Avisos.** Tabla `notice`, **de la sede** y no de cada persona: cuando un líder atiende uno, deja de
estar pendiente para todos los líderes de la sede (el panel es compartido y así nadie revisa dos
veces). Se crean en la misma transacción que el evento:

- `attendance-review`: una entrada o salida que deja algo por revisar. A lo más uno pendiente por
  jornada (índice único parcial); la salida que agrega motivos actualiza el mismo.
- `justification`: llegó una justificación.

Se atienden solos al revisar la jornada (o al corregirla si ya no queda nada) y al resolver la
justificación, o a mano con `POST /sites/:siteId/notices/:id/read` ("ya lo vi"), que no revisa ni
resuelve nada. `GET /sites/:siteId/notices` da los pendientes (o `?status=all`, también los del último
mes) y cuántos hay. Ver y atender avisos pide `attendance:read`, así que el encargado también los ve.
No se borran. Las notificaciones push saldrán de esta tabla.

**Excel.** "Por revisar" muestra solo lo pendiente; columnas nuevas "Revisado" (motivos y comentario)
y "Corregida" (fecha de la última corrección).

## Consecuencias

- Dos tablas nuevas (`attendance_correction`, `notice`) con RLS forzado, FK compuestas y CHECK;
  `attendance_record` gana columnas de revisión y corrección. `justification` gana el índice único
  `(id, company_id)` para la FK compuesta del aviso.
- Corregir la entrada recalcula el retardo con la tolerancia **actual**, no con la que había al
  marcar (no se guarda la histórica). Si se cambió la tolerancia entretanto, el retardo corregido usa
  la nueva. Una justificación de retardo ya enviada sigue ahí aunque la corrección quite el retardo.
- Corregir una salida no cambia la autorización de horas extra; los minutos se recalculan al leer.
- Los avisos de un trabajador que ya no está en la sede se siguen mostrando hasta atenderse.
- Fuera de esta semana: cambio de sede del trabajador con aviso (regla 14; depende de cómo se asignan
  sedes en Axeda), notificaciones push, avisos por salida pendiente (el panel ya las muestra).
