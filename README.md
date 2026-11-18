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
    attendance/      Jornada. rules/ son funciones puras, sin Nest ni base de datos.
prisma/              Esquema y migraciones (las de RLS se escriben a mano).
docker/postgres/     Roles y base para desarrollo y CI.
test/                Pruebas de aislamiento contra PostgreSQL.
docs/adr/            Decisiones (0009: NestJS sobre Express).
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

### Cookies

Better Auth usa cookies `HttpOnly` y `SameSite=Lax`, así que frontend y API deben estar en el mismo
sitio (por ejemplo `app.tempora.mx` y `api.tempora.mx`). En producción: `COOKIE_DOMAIN=tempora.mx`,
el origen del frontend en `TRUSTED_ORIGINS` y `BETTER_AUTH_URL` con https. Las escrituras con cookie
desde un origen que no está en la lista reciben 403.

## Pendiente

- Jornada (semana 3): entrada tardía con código vencido, panel del líder, marcado manual y corrección de
  "salida pendiente" con comentario, y avisos al líder.
- Horario oficial y tolerancia de retardo de cada sede (pregunta abierta 4 del PRD).

- WhatsApp con Meta como canal principal (Twilio queda de respaldo), cuando esté la cuenta aprobada.
- Elegir proveedor de correo y conectarlo en `src/auth/messaging.ts`.
- Reglas del encargado que Axeda deja a Tempora: duración máxima, misma sede, avisar al administrador.
- Pantalla de aceptación de invitaciones en el frontend (`/invitacion?token=...`).
