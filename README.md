# Tempora API

API de Tempora, el registro electrónico de jornada laboral (Ley Federal del Trabajo, obligatorio desde
el 1 de enero de 2027). NestJS 12 sobre Express 5, PostgreSQL 16, Prisma 7, Better Auth y Axeda.

## Levantarlo en local

Requisitos: Node 22.12 o más y Docker (o un PostgreSQL 16/18 propio).

```bash
docker compose up -d          # PostgreSQL con los roles y la base "tempora"
cp .env.example .env          # y pon un BETTER_AUTH_SECRET: openssl rand -base64 48
npm install                   # también genera el cliente de Prisma
npm run db:migrate            # migraciones de Prisma (app) y de Better Auth/Axeda (auth)
npm run start:dev
```

- API: <http://localhost:3000> · documentación OpenAPI: <http://localhost:3000/docs>
- Autenticación (Better Auth y endpoints de Axeda): `/api/auth/...`
- Los correos (verificación, invitaciones) y los SMS (códigos, invitaciones) se imprimen en la consola
  en desarrollo.
- Primer dueño de la plataforma: regístrate y luego `npm run bootstrap:admin -- tu@correo.com`.

Sin Docker: corre `docker/postgres/01-roles.sql` y `02-database.sql` con `psql` como superusuario.

## Comandos

| Comando                                                 | Qué hace                                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `npm run start:dev`                                     | API con recarga                                                               |
| `npm run build` / `npm run start:prod`                  | Compila a `dist/` y la corre                                                  |
| `npm test`                                              | Pruebas unitarias (sin base de datos)                                         |
| `npm run test:e2e`                                      | Pruebas contra PostgreSQL real: crea una base temporal y la borra al terminar |
| `npm run lint` / `npm run typecheck` / `npm run format` | oxlint, tipos y Prettier                                                      |
| `npm run db:migrate:dev -- --name x --create-only`      | Nueva migración de Prisma                                                     |
| `npm run db:migrate`                                    | Aplica migraciones de app y auth                                              |
| `npm run pilot:setup -- piloto.json`                    | Da de alta la compañía, sede y personas del piloto (ver abajo)                |
| `docker build -t tempora-api .`                         | Imagen de producción (ver `docs/runbooks/produccion.md`)                      |

## Cómo está armado

```
src/
  config/            Variables de entorno validadas con Zod. Si falta una, no arranca.
  auth/              Better Auth + Axeda, catálogo de permisos y roles, PermissionGuard.
  database/          Prisma 7 y TenantDb (transacción con la compañía de la petición para RLS).
  tenancy/           Contexto por petición (nestjs-cls): quién y en qué compañía.
  modules/
    sites/           Datos de Tempora de cada sede de Axeda: ubicación y radio.
    employees/       Perfiles de recursos humanos.
    audit/           Auditoría de solo inserción.
    privacy/         Aceptación del aviso de privacidad y el guard que bloquea la jornada sin ella.
    attendance/      Jornada. rules/ son funciones puras, sin Nest ni base de datos.
prisma/              Esquema y migraciones (las de RLS se escriben a mano).
docker/postgres/     Roles y base para desarrollo y CI.
test/                Pruebas de aislamiento contra PostgreSQL.
docs/adr/            Decisiones (0009 a 0015).
```

Compañías, negocios, sedes y usuarios viven en Axeda (esquema `auth`); el frontend los administra con
los endpoints de Axeda (`/api/auth/axeda/...`). Tempora guarda sus identificadores como texto, sin
claves foráneas entre esquemas. Una sede se crea en Axeda (`/axeda/site/create`) y luego se le pone
ubicación y radio con `PUT /sites/:siteId`.

### Base de datos: tres roles

| Rol             | Para qué                                                            |
| --------------- | ------------------------------------------------------------------- |
| `tempora_owner` | Dueño del esquema `app`. Solo migraciones de Prisma.                |
| `tempora_app`   | El que usa la API para `app`. No es dueño de nada y no salta RLS.   |
| `tempora_auth`  | Dueño del esquema `auth` (Better Auth y Axeda). Sin acceso a `app`. |

### Aislamiento por compañía (dos capas)

1. **RLS de PostgreSQL** en cada tabla de `app`: `ENABLE` y `FORCE`, con una política `USING` y
   `WITH CHECK` sobre `company_id = app.current_company_id()`. Sin compañía fijada no se ve ni se
   escribe nada.
2. **Repositorios** que también filtran por `companyId`. Los controladores nunca usan Prisma.

La compañía sale de la ruta (`/companies/:companyId/...` o, en rutas de sede, `/sites/:siteId/...`, cuya
compañía y negocio se leen de Axeda), la valida `PermissionGuard` y se guarda en el contexto de la petición. `TenantDb.run(tx => ...)` abre una transacción con
`set_config('app.company_id', ..., true)`, que vale solo para esa transacción.

**Al agregar una tabla** en `app`: columna `company_id`, `ENABLE` + `FORCE ROW LEVEL SECURITY`, política
y `GRANT` a `tempora_app` en la migración, y FK compuestas `(id, company_id)` si referencia otra tabla
de negocio (las FK no pasan por RLS). La prueba de catálogo en `test/rls.e2e-spec.ts` falla si falta algo.

### Permisos y roles

El código decide siempre por permiso, nunca por el nombre de un rol (`src/auth/permissions.ts`).
Cada ruta declara `@RequirePermission(permiso, { company: 'companyId' })` (o `{ site: 'siteId' }`,
`{ business: ... }`) o `@Public()`; lo demás se niega. Una asignación de compañía vale en sus negocios y
sedes; una de sede, solo en esa sede. Roles: administrador de compañía, administrador de negocio, líder, trabajador y encargado. El
dueño de la plataforma es el administrador global de Axeda y **no** recibe permisos de datos de clientes
(asistencia, empleados, auditoría): esos solo cuentan si se conceden en la compañía o el negocio.

### Quién otorga qué

Axeda deja otorgar un rol a quien tenga el permiso de gestión en ese lugar y cubra los permisos del rol.
Eso permitiría a un líder nombrar a otro líder. Tempora lo cierra con un hook de Better Auth que revisa
`/axeda/assignment/create`, `/axeda/assignment/revoke` y `/axeda/invitation/create` antes de que lleguen
a Axeda (`GRANT_POLICY` en `src/auth/permissions.ts`): un líder (autoridad de sede) solo otorga o quita
trabajador y encargado; un administrador de negocio, hasta líder y administrador de negocio; uno de
compañía, cualquiera. Responde 403 con `code: TEMPORA_GRANT_FORBIDDEN`.

### Teléfono e invitaciones

- Acceso por teléfono con el plugin `phoneNumber` de Better Auth y el preset de Axeda: código de 6
  dígitos, 5 minutos, 3 intentos, solo E.164 y tope de envíos por número. Quien entra solo con teléfono
  recibe un correo de relleno (`@phone.invalid`); no lo uses como identificador.
- Invitaciones por correo o teléfono, con enlace `APP_URL/invitacion?token=...`. El frontend acepta con
  `POST /api/auth/axeda/invitation/accept`.
- Los envíos pasan por `Mailer` y `SmsSender` (`src/auth/messaging.ts`). Los SMS salen por Twilio con
  `SMS_PROVIDER=twilio` (ADR 0011); en desarrollo, `console` los imprime.

### SMS con Twilio

1. En la consola de Twilio copia el Account SID (`AC...`). Para producción crea una API key (`SK...`) y
   usa su secreto como `TWILIO_AUTH_TOKEN`; en desarrollo basta el Auth Token de la cuenta.
2. Pon el remitente: un número de Twilio en `TWILIO_FROM` (E.164) o un Messaging Service en
   `TWILIO_MESSAGING_SERVICE_SID` (`MG...`), que conviene para México por el registro de remitentes.
3. En `.env`: `SMS_PROVIDER=twilio` y esas variables. Si falta alguna, la API no arranca y dice cuál.

Para probar sin gastar, usa las credenciales de prueba de Twilio con `TWILIO_FROM=+15005550006`.
Los registros guardan el canal y el código de error de Twilio, nunca el texto ni el código de acceso.

`withFallback` (`src/auth/sms/fallback.ts`) prueba canales en orden. Hoy solo hay Twilio; cuando
WhatsApp (Meta) esté listo se agrega primero en `src/auth/sms/from-config.ts` y Twilio queda de respaldo.

### Correo con Resend (ADR 0017)

`MAIL_PROVIDER=console` (desarrollo) imprime los correos; `MAIL_PROVIDER=resend` los manda con la API
de Resend (`RESEND_API_KEY`, `MAIL_FROM` con un dominio verificado, `MAIL_REPLY_TO` opcional). En
producción la API no arranca con `console`. Dos correos, en texto y HTML sencillo, solo con el enlace:
verificación de cuenta e invitación (`src/auth/mail/`). A los correos de relleno de quien entra por
teléfono (`@phone.invalid`) no se manda nada.

### Jornada: código diario, entrada y salida

| Ruta                                       | Permiso           | Qué hace                                                       |
| ------------------------------------------ | ----------------- | -------------------------------------------------------------- |
| `POST /sites/:siteId/daily-code`           | `daily-code:show` | Genera el código de 6 dígitos (20 a 30 min); vence el anterior |
| `GET /sites/:siteId/daily-code`            | `daily-code:show` | El código vigente (404 si no hay)                              |
| `POST /sites/:siteId/attendance/check-in`  | `attendance:mark` | Entrada con `{ code, location? }`                              |
| `POST /sites/:siteId/attendance/check-out` | `attendance:mark` | Salida con `{ location?, reason? }`                            |
| `GET /sites/:siteId/attendance/me`         | `attendance:mark` | Mi jornada de hoy y las que quedaron sin salida                |

- La hora la pone el servidor (`Clock`); el cuerpo nunca trae hora.
- Fuera del radio o sin ubicación, la entrada **no se rechaza**: queda con `needsReview` y el motivo en
  `reviewReasons` (`entry:outside-radius`, `entry:no-location`), con la distancia real.
- La salida se clasifica con el horario de la sede (`shiftStart`/`shiftEnd` en `PUT /sites/:siteId`):
  antes de 30 minutos del cierre es anticipada y exige `reason`; más de 30 minutos de diferencia la
  manda a revisión (`exit:off-schedule`). Sin horario configurado, toda salida es normal.
- Una jornada por trabajador y día (fecha local de la sede). Si olvida la salida, al día siguiente queda
  como `pending-exit` y ya no la puede cerrar él (la corrige el líder, semana 3).
- Errores de negocio con `code` estable (`TEMPORA_CODE_INVALID`, `TEMPORA_CODE_EXPIRED`,
  `TEMPORA_ALREADY_CHECKED_IN`, `TEMPORA_EXIT_PENDING`, ...; ver `attendance.schemas.ts`).
- Tope de 10 intentos de entrada por usuario y minuto (429), contra adivinar el código.
- Cada código, entrada y salida deja auditoría en la misma transacción, sin coordenadas (solo distancia).
- La API no tiene `DELETE` sobre `daily_code` ni `attendance_record`.

### Jornada: panel del líder, marcado manual, calendario y Excel

| Ruta                                                   | Permiso                  | Qué hace                                                         |
| ------------------------------------------------------ | ------------------------ | ---------------------------------------------------------------- |
| `GET /sites/:siteId/attendance/day?date=`              | `attendance:read`        | Quién llegó y quién falta (hoy por defecto) y salidas pendientes |
| `POST /sites/:siteId/attendance/manual/check-in`       | `attendance:mark-manual` | Entrada por un trabajador: `{ userId, comment, at? }`            |
| `POST /sites/:siteId/attendance/manual/check-out`      | `attendance:mark-manual` | Salida por un trabajador: `{ userId, comment, at?, workDate? }`  |
| `GET /sites/:siteId/attendance/me/calendar?month=`     | `attendance:mark`        | Mi mes en la sede, día por día, con totales                      |
| `GET /sites/:siteId/attendance/users/:userId/calendar` | `attendance:read`        | El mes de un trabajador, para el líder                           |
| `GET /sites/:siteId/attendance/export?from=&to=`       | `report:export`          | Excel de la sede                                                 |
| `GET /businesses/:businessId/attendance/export`        | `report:export`          | Excel del negocio (mismos `from` y `to`)                         |
| `GET /companies/:companyId/attendance/export`          | `report:export`          | Excel de toda la compañía                                        |

- La plantilla de la sede es quien tiene una asignación vigente de Axeda en ella con un rol que marca
  asistencia (`attendance:mark`). Quien marcó pero ya no está asignado sale con `onRoster: false`.
- Cada entrada y salida dice quién la registró: `checkInSource`/`checkOutSource` es `self` (el
  trabajador, con código) o `manual` (el líder), con `checkInBy`/`checkOutBy` y el comentario. La
  base exige autor y comentario en lo manual y rechaza que alguien se registre a sí mismo a mano.
- Marcado manual: solo para gente de la sede, hasta 7 días atrás, nunca en el futuro, jornadas de
  máximo 24 horas. Para cerrar una salida pendiente de otro día, `at` (la hora real) es obligatoria.
  Errores: `TEMPORA_MANUAL_SELF`, `TEMPORA_NOT_SITE_EMPLOYEE`, `TEMPORA_MANUAL_TIME_INVALID`,
  `TEMPORA_MANUAL_TIME_REQUIRED`.
- El panel da `minutesAfterStart` (minutos después de la entrada oficial), no "retardo": falta la
  tolerancia de cada sede. En el calendario, un día sin jornada es `no-record`, no "falta".
- Excel: hoja "Jornadas" (una fila por jornada, horas locales de la sede, horas en decimal, quién
  registró cada parte, comentarios y motivos de revisión) y "Resumen" (por persona y sede). Rango de
  hasta 62 días. Solo horas, nunca dinero. Cada exportación queda en la auditoría. El líder no
  exporta: `report:export` es de los administradores.
- Prueba manual en Windows: `scripts/prueba-panel.ps1` (ADR 0013).

### Jornada: retardos, justificaciones, horas extra, festivos y aviso de privacidad (ADR 0014)

| Ruta                                             | Permiso                 | Qué hace                                                                           |
| ------------------------------------------------ | ----------------------- | ---------------------------------------------------------------------------------- |
| `GET /sites/:siteId/privacy-notice`              | `attendance:mark`       | Versión vigente del aviso y si ya la aceptó                                        |
| `POST /sites/:siteId/privacy-notice/accept`      | `attendance:mark`       | Acepta `{ version }` (idempotente; 409 si no es la vigente)                        |
| `POST /sites/:siteId/attendance/late-check-in`   | `attendance:mark`       | Entrada tardía con un código de hoy ya vencido                                     |
| `POST /sites/:siteId/justifications`             | `justification:write`   | Justifica `{ workDate, kind, reason }` (late, early-exit, absence)                 |
| `GET /sites/:siteId/justifications/me`           | `justification:write`   | Mis justificaciones en la sede                                                     |
| `GET /sites/:siteId/justifications?status=`      | `justification:resolve` | Las de la sede, para el líder                                                      |
| `POST /sites/:siteId/justifications/:id/approve` | `justification:resolve` | Aprueba (`comment` opcional)                                                       |
| `POST /sites/:siteId/justifications/:id/reject`  | `justification:resolve` | Rechaza (`comment` obligatorio)                                                    |
| `POST /sites/:siteId/overtime`                   | `overtime:authorize`    | Autoriza `{ userId, workDate?, until?, reason }`; `until: null` es jornada abierta |
| `POST /sites/:siteId/overtime/:id/close`         | `overtime:authorize`    | Cierra la autorización ahora                                                       |
| `GET /sites/:siteId/overtime?date=`              | `attendance:read`       | Autorizaciones del día, con sus minutos                                            |
| `GET /companies/:companyId/holidays?year=`       | `site:read`             | Festivos de la compañía y sus sedes                                                |
| `POST /companies/:companyId/holidays`            | `holiday:manage`        | Festivo para todas las sedes `{ date, name }`                                      |
| `POST /companies/:companyId/holidays/statutory`  | `holiday:manage`        | Carga los del art. 74 de la LFT de `{ year }`                                      |
| `DELETE /companies/:companyId/holidays/:id`      | `holiday:manage`        | Borra un festivo (queda auditado)                                                  |
| `GET /sites/:siteId/holidays?year=`              | `site:read`             | Los que valen en la sede                                                           |
| `POST /sites/:siteId/holidays`                   | `holiday:manage`        | Festivo solo de la sede                                                            |

- **Aviso de privacidad**: hasta aceptar la versión vigente (`PRIVACY_NOTICE_VERSION`) en la compañía,
  entrada, salida, `me`, `me/calendar` y las justificaciones propias dan 403
  `TEMPORA_PRIVACY_NOT_ACCEPTED`. Es por compañía y de solo inserción.
- **Retardo**: `PUT /sites/:siteId` acepta `lateToleranceMin` (10 por omisión) y `restDays` (0 =
  domingo ... 6 = sábado; `[0]` por omisión). Cada jornada trae `late`, `lateMinutes` y
  `checkInCodeExpired`, decididos al entrar. En descanso o festivo no hay retardo.
- **Horas extra**: cada jornada trae `overtime` (null sin horario) con `extraMinutes`,
  `authorizedMinutes`, `unauthorizedMinutes` y la autorización; `inProgress` mientras sigue dentro.
  No se autoriza después de la salida ni a uno mismo. Dobles y triples, después del 1 de enero.
- **Días**: el panel trae `day` (`dayType`, `sunday`, `holidayName`, `workday`); cada día del
  calendario también, con `status: 'day-off'` en descansos y festivos sin jornada, sus justificaciones
  y totales de retardos, horas extra y domingos, descansos y festivos trabajados. El Excel suma esas
  columnas.
- Prueba manual en Windows: `scripts/prueba-jornada.ps1`.

### Jornada: corrección de horas, revisión y avisos al líder (ADR 0015)

| Ruta                                                 | Permiso              | Qué hace                                                             |
| ---------------------------------------------------- | -------------------- | -------------------------------------------------------------------- |
| `GET /sites/:siteId/attendance/review?from=&to=`     | `attendance:read`    | Jornadas con motivos sin revisar (último mes por omisión)            |
| `GET /sites/:siteId/attendance/records/:id`          | `attendance:read`    | Una jornada con la persona y su historial de correcciones            |
| `POST /sites/:siteId/attendance/records/:id/correct` | `attendance:correct` | Corrige `{ checkInAt?, checkOutAt?, comment }`                       |
| `POST /sites/:siteId/attendance/records/:id/review`  | `attendance:correct` | Marca como revisados sus motivos (`comment` opcional)                |
| `GET /sites/:siteId/notices?status=`                 | `attendance:read`    | Avisos de la sede: pendientes (`open`, por omisión) o `all` del mes  |
| `POST /sites/:siteId/notices/:id/read`               | `attendance:read`    | "Ya lo vi": lo quita de pendientes para todos los líderes de la sede |

- **Corregir**: hasta 31 días atrás, en el mismo día de jornada, nunca en el futuro ni la propia. Solo
  se corrige una salida que existe (si falta, `manual/check-out`). Con la hora nueva se recalculan el
  retardo, el tipo de salida y "fuera de horario". Cada corrección queda en `attendance_correction`
  con el valor anterior y el nuevo. Errores: `TEMPORA_CORRECTION_INVALID`, `TEMPORA_CORRECTION_SELF`,
  `TEMPORA_RECORD_NOT_FOUND`, `TEMPORA_RECORD_CHANGED`.
- **Revisar**: los motivos (`reviewReasons`) se conservan; los revisados van en `reviewedReasons`.
  `needsReview` es true si queda alguno sin revisar, así que un motivo nuevo (por ejemplo, la salida
  fuera del radio) vuelve a pedir revisión. Errores: `TEMPORA_NOTHING_TO_REVIEW`, `TEMPORA_REVIEW_SELF`.
- **Avisos**: se crean solos con una entrada o salida por revisar (`attendance-review`, uno pendiente
  por jornada) y con cada justificación (`justification`). Se atienden solos al revisar o resolver.
  Son de la sede, no de una persona. Las notificaciones push saldrán de aquí (después del 1 de enero).
- El encargado ve la lista, el detalle y los avisos, pero no corrige ni revisa.
- Excel: "Por revisar" trae solo lo pendiente; columnas nuevas "Revisado" y "Corregida".
- Prueba manual en Windows: `scripts/prueba-correcciones.ps1`.

### Producción y alta del piloto (ADR 0016)

Guía completa en [`docs/runbooks/produccion.md`](docs/runbooks/produccion.md): roles de Postgres,
variables, despliegue con la imagen, respaldos y la lista antes del piloto.

- Imagen: `Dockerfile` (usuario sin privilegios). Arranca la API; `npm run db:migrate:prod` en la
  misma imagen aplica las migraciones antes de cada despliegue. CI la construye en cada cambio.
- `GET /health`: el proceso responde. `GET /health/ready`: además, las dos conexiones a la base (503
  si alguna falla).
- `TRUST_PROXY`: cuántos proxies hay delante (en la plataforma, `1`). Sin él, la IP es la de la
  conexión y cambiar `X-Forwarded-For` no salta los topes de intentos.
- Alta del piloto: `npm run pilot:setup -- piloto.json` con un archivo como
  `docs/runbooks/piloto.example.json` (en la imagen, `node dist/src/cli/pilot-setup.js - < piloto.json`).
  Crea compañía, negocio y sede en Axeda, guarda la ubicación y el horario, carga festivos e invita a
  las personas. Se puede repetir sin duplicar nada; `--solo-enlaces` imprime los enlaces sin mandar
  SMS y `--reenviar` manda de nuevo las invitaciones vigentes.
- Prueba manual en Windows: `scripts/prueba-piloto.ps1` (con `-Docker`, también construye la imagen).

### Cookies

Better Auth usa cookies `HttpOnly` y `SameSite=Lax`, así que frontend y API deben estar en el mismo
sitio (por ejemplo `app.tempora.mx` y `api.tempora.mx`). En producción: `COOKIE_DOMAIN=tempora.mx`,
el origen del frontend en `TRUSTED_ORIGINS` y `BETTER_AUTH_URL` con https. Las escrituras con cookie
desde un origen que no está en la lista reciben 403.

## Pendiente

- Jornada: cambio de sede del trabajador con historial y aviso al líder (regla 14), cuando se defina
  cómo se asignan sedes en Axeda.
- Después del 1 de enero: horas extra dobles y triples, disputa de justificaciones con RH, comisiones
  (regla 11), descansos por cuadrilla, notificaciones push (saldrán de los avisos de ADR 0015).

- WhatsApp con Meta como canal principal (Twilio queda de respaldo), cuando esté la cuenta aprobada.
- Contadores de intentos en la base, para poder correr más de una instancia.
- Reglas del encargado que Axeda deja a Tempora: duración máxima, misma sede, avisar al administrador.
- Pantalla de aceptación de invitaciones en el frontend (`/invitacion?token=...`).
