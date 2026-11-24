# ADR 0014: Retardos, justificaciones, horas extra, festivos y aviso de privacidad

- Estado: aceptada (valores por omisión confirmados por Noel el 2026-11-23)
- Fecha: 2026-11-18

## Contexto

Semanas 5 y 6 del plan, adelantadas: retardos y entrada tardía (regla 10), justificaciones (regla 12,
versión simple), horas extra con autorización del líder (regla 9), etiquetado de días (reglas 15 y 16)
y el lado de la API del aviso de privacidad (requisito no funcional del PRD). Dobles y triples, la
disputa con Recursos Humanos, las comisiones (regla 11) y el encargado quedan para después del 1 de
enero. El PRD deja abiertos la tolerancia (pregunta 4) y la "cuadrilla" (pregunta 3): aquí se eligen
valores por omisión que se pueden cambiar.

## Decisión

**Retardo.** Cada sede tiene `lateToleranceMin` (por omisión **10**, de 0 a 120). Hay retardo si la
entrada pasa de la entrada oficial más la tolerancia (llegar justo al límite no lo es). Se decide **al
registrar la entrada** y se guarda (`check_in_late`, `check_in_late_minutes`): cambiar la tolerancia
después no reescribe la historia. En un descanso o festivo no hay retardo. Sin horario en la sede,
solo cuenta como retardo la entrada tardía. El marcado manual del líder también cuenta retardo.

**Entrada tardía (regla 10).** `POST /sites/:siteId/attendance/late-check-in` acepta un código de la
sede **generado hoy** que ya venció (no uno vigente ni uno de otro día), y la jornada queda con
`checkInCodeExpired: true`. Así no se puede entrar sin haber visto un código ese día.

**Justificaciones.** El trabajador escribe la suya (`late`, `early-exit` o `absence`) de los últimos
31 días; una por día y tipo. El **líder** la aprueba o la rechaza (rechazo con comentario). Para eso el
rol de líder gana `justification:resolve`; el encargado no. El rechazo es final hasta que exista la
disputa con RH. Nadie resuelve la suya (lo impide también un CHECK). Una justificación no borra el
retardo: lo explica, y el Excel muestra las dos cosas.

**Horas extra.** El líder (`overtime:authorize`; el encargado no) autoriza a un trabajador de su sede
para un día: **antes** (hasta 7 días) o **en vivo** (hoy, o ayer en turno de noche), hasta una hora
(`until`) o como **jornada abierta** (`until: null`) que cierra con `POST .../overtime/:id/close`.
No se autoriza después de la salida. Se cuentan solo los minutos después del cierre oficial: los que
cubre la autorización son "autorizados" y el resto "tiempo no autorizado" (se trabajó; nómina decide,
pendientes legales 5). Una salida tarde no va a revisión (regla 8) si lo no autorizado no pasa de 30
minutos. Sin horario en la sede no hay horas extra (409 `TEMPORA_SHIFT_REQUIRED`). Se muestran minutos
exactos, sin redondeo ni umbral.

**Días.** Cada día es `ordinary`, `sunday`, `rest` o `holiday` (en ese orden de menor a mayor peso),
con `sunday: true` aparte para la prima dominical. Los descansos son **de la sede** (`restDays`, por
omisión **[0], domingo**; LFT art. 69). La cuadrilla queda para después: cuando exista, sus días
sustituyen a los de la sede. Los festivos son de la compañía (todas sus sedes) o de una sede; se
cargan los del artículo 74 de la LFT con un llamado por año (sin el día de elecciones, que se agrega a
mano). Un festivo de la sede gana al de la compañía el mismo día. El calendario distingue `no-record`
(día laborable sin jornada) de `day-off` (descanso o festivo sin jornada).

**Aviso de privacidad.** La versión vigente es `PRIVACY_NOTICE_VERSION` (el texto vive en el
frontend). Cada persona la acepta **por compañía** (el aviso es del patrón) desde
`POST /sites/:siteId/privacy-notice/accept`; se guarda versión, hora, IP y navegador, de solo
inserción, con auditoría. Hasta aceptarla, las rutas donde la persona marca o ve **su propia** jornada
responden 403 `TEMPORA_PRIVACY_NOT_ACCEPTED`: entrada, entrada tardía, salida, `me`, `me/calendar` y
sus justificaciones. El panel del líder, el marcado manual y la exportación no se bloquean (no recogen
datos personales del que las usa). Cambiar la versión pide aceptar de nuevo.

## Consecuencias

- Cuatro tablas nuevas (`holiday`, `justification`, `overtime_authorization`, `privacy_acceptance`) con
  RLS forzado, FK compuestas y CHECK; sin `DELETE` salvo en `holiday`, que es configuración.
- Un festivo cargado después de que alguien marcó no quita un retardo ya registrado: se resuelve con
  una justificación.
- `PUT /sites/:siteId` gana `lateToleranceMin` y `restDays`; como es PUT, si no se mandan vuelven al
  valor por omisión.
- El frontend debe mostrar el aviso al primer ingreso (y al cambiar de versión) y ofrecer "Registrar
  entrada tardía" cuando la entrada responde `TEMPORA_CODE_EXPIRED`.
- Confirmado por Noel el 2026-11-23: tolerancia de 10 minutos; domingo como descanso por omisión en
  todas las sedes; el encargado no autoriza horas extra ni resuelve justificaciones; una
  justificación rechazada no se puede reenviar (hasta que exista la disputa con RH).
