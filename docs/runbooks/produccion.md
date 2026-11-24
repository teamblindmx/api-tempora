# Producción: cómo se despliega y se opera la API

Para el piloto de mediados de diciembre y la salida del 1 de enero de 2027. Decisión de fondo en
[ADR 0016](../adr/0016-lista-para-el-piloto.md): la API corre como imagen Docker en una plataforma
administrada (Railway, Render, Fly o similar) y PostgreSQL 16 es un servicio administrado aparte.

## 1. Base de datos

1. Crea un PostgreSQL 16 administrado con respaldos diarios y recuperación a un punto en el tiempo
   (PITR). Misma región que la API.
2. Con el usuario administrador que te da la plataforma, corre `docker/postgres/01-roles.sql` y luego
   cambia las tres contraseñas de desarrollo por unas largas y aleatorias:

   ```sql
   ALTER ROLE tempora_owner PASSWORD '...';
   ALTER ROLE tempora_app   PASSWORD '...';
   ALTER ROLE tempora_auth  PASSWORD '...';
   ```

   Si la plataforma no deja crear roles con `NOBYPASSRLS`, no sirve: RLS es la segunda capa de
   aislamiento entre compañías.

3. Corre `docker/postgres/02-database.sql` (crea la base `tempora`, quita permisos de `public` y crea
   el esquema `auth`). Si la plataforma ya creó la base, corre solo las líneas después de
   `\connect tempora`.
4. Pide TLS en las tres URL (`?sslmode=require`; en `DATABASE_URL_AUTH` se agrega con `&`).

## 2. Variables de entorno de la API

| Variable                                                        | Valor en producción                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `NODE_ENV`                                                      | `production` (ya viene en la imagen)                                                 |
| `PORT`                                                          | La que pida la plataforma (3000 por omisión)                                         |
| `DATABASE_URL`                                                  | Rol `tempora_app`                                                                    |
| `DATABASE_URL_AUTH`                                             | Rol `tempora_auth`, con `options=-c%20search_path%3Dauth`                            |
| `DATABASE_URL_OWNER`                                            | Rol `tempora_owner`. Solo para migrar: si la plataforma lo permite, solo en ese paso |
| `BETTER_AUTH_SECRET`                                            | `openssl rand -base64 48`. Cambiarlo cierra todas las sesiones                       |
| `BETTER_AUTH_URL`                                               | `https://api.<dominio>` (la API no arranca sin https)                                |
| `TRUSTED_ORIGINS`                                               | `https://app.<dominio>`                                                              |
| `COOKIE_DOMAIN`                                                 | `<dominio>` (frontend y API en subdominios del mismo dominio)                        |
| `APP_URL`                                                       | `https://app.<dominio>` (enlaces de invitación)                                      |
| `TRUST_PROXY`                                                   | `1` detrás del balanceador de la plataforma (ver abajo)                              |
| `MAIL_PROVIDER`                                                 | `resend` (con `console` la API no arranca en producción)                             |
| `RESEND_API_KEY`                                                | Llave de Resend con permiso de solo envío                                            |
| `MAIL_FROM`                                                     | `Tempora <no-responder@<dominio>>`, con el dominio verificado en Resend              |
| `MAIL_REPLY_TO`                                                 | Opcional: a dónde llegan las respuestas                                              |
| `SMS_PROVIDER`                                                  | `twilio` (con `console` la API no arranca en producción)                             |
| `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_AUTH_TOKEN` | API key de Twilio (mejor que el Auth Token de la cuenta)                             |
| `TWILIO_FROM` o `TWILIO_MESSAGING_SERVICE_SID`                  | Remitente                                                                            |
| `PRIVACY_NOTICE_VERSION`                                        | La versión del aviso que revisó el abogado                                           |
| `DB_POOL_MAX`, `AUTH_POOL_MAX`                                  | 10 y 5; que la suma no pase del límite de conexiones del plan de Postgres            |

**Resend.** En Resend, agrega el dominio (mejor un subdominio para correo, p. ej.
`correo.<dominio>`), pon en el DNS los registros SPF y DKIM que te da y espera a que diga
"verified"; sin eso Resend rechaza el envío. Crea una llave con permiso **solo de envío** para ese
dominio. Los correos llevan solo el enlace (verificación de cuenta o invitación), nunca datos de la
persona. A los correos de relleno de quien entró por teléfono (`@phone.invalid`) no se manda nada.

**`TRUST_PROXY`.** La IP del cliente sirve para los topes de intentos (inicio de sesión, códigos por
SMS) y para la auditoría. Detrás de un balanceador, la conexión llega desde el balanceador:

- Vacío: la API toma la IP de la conexión. Detrás de un balanceador, todos los usuarios comparten esa
  IP y se acaban los intentos de todos a la vez.
- `1`: confía en un salto de `X-Forwarded-For`, el que agrega el balanceador. Es lo normal en una
  plataforma. Si hay otro proxy delante (Cloudflare), `2`.
- Nunca `true` si alguien puede llegar a la API sin pasar por el balanceador: podría elegir su IP.

Revisa que funcione después de desplegar: inicia sesión mal seis veces desde tu teléfono con datos
móviles. La sexta da 429, y desde la computadora (otra IP) todavía se puede entrar.

## 3. Despliegue

La plataforma construye la imagen con el `Dockerfile` de la raíz (o la toma de un registro).

- **Comando de arranque:** el de la imagen (`node dist/src/main.js`).
- **Comando previo al despliegue** (release / pre-deploy): `npm run db:migrate:prod`. Aplica las
  migraciones de Prisma y luego las de Better Auth y Axeda. Si falla, no se despliega la versión nueva.
- **Salud:** `GET /health` para saber si el proceso vive (reiniciarlo si no) y `GET /health/ready`
  para mandarle tráfico (prueba las dos conexiones a la base; 503 si alguna falla).
- **Una sola instancia** durante el piloto: los topes de intentos se cuentan en memoria. Para tener
  varias, primero hay que mover esos contadores a la base (pendiente).
- Regla para las migraciones nuevas: que la versión anterior de la API siga funcionando con ellas
  (agregar columnas y tablas; renombrar o borrar, en dos despliegues), porque la versión anterior
  sigue atendiendo mientras arranca la nueva.

## 4. Primer arranque y alta del piloto

1. Regístrate con tu correo en el frontend y abre el enlace de verificación que te llega.
2. Hazte dueño de la plataforma (una sola vez), desde la consola de la plataforma o con
   `docker run` y las mismas variables:

   ```bash
   node dist/src/cli/bootstrap-admin.js tu@correo.com
   ```

3. Llena un `piloto.json` como `docs/runbooks/piloto.example.json` (compañía, negocio, sede con
   coordenadas y horario, años de festivos, personas con su rol) y córrelo:

   ```bash
   node dist/src/cli/pilot-setup.js - < piloto.json            # en la imagen, leyendo de la entrada
   npm run pilot:setup -- piloto.json                         # en tu máquina, con las variables de producción
   ```

   Se puede repetir: lo que existe no se duplica, la sede toma la configuración del archivo y a quien
   ya tiene una invitación vigente no se le manda otra (`--reenviar` para mandarla de nuevo). Con
   `--solo-enlaces` no se manda ningún SMS ni correo y los enlaces salen en pantalla para
   compartirlos a mano (por ejemplo, por WhatsApp).

4. Cada persona abre su enlace, entra con su teléfono (código por SMS) y acepta el aviso de privacidad
   antes de su primer marcado.

## 5. Respaldos

- La plataforma hace respaldos diarios y PITR: confirma cuántos días guarda.
- **Antes del piloto, prueba una restauración** en una base nueva y que la API arranque con ella.
- Además, un `pg_dump` semanal (con `tempora_owner`, que ve todo el esquema `app`) guardado fuera de la
  plataforma. Los registros de jornada son la evidencia ante una inspección: confirma con el abogado
  cuántos años hay que guardarlos.
- `audit_log` y `attendance_correction` no se borran nunca (la API no tiene permiso de `DELETE`).

## 6. Lista antes del piloto

- [ ] Postgres administrado con respaldos y PITR; restauración probada.
- [ ] Roles con contraseñas nuevas; `tempora_app` y `tempora_auth` sin `BYPASSRLS`.
- [ ] Dominio con https para la API y el frontend (mismo dominio padre) y `COOKIE_DOMAIN`.
- [ ] Todas las variables de la tabla; `TRUST_PROXY` probado con seis intentos fallidos.
- [ ] Dominio verificado en Resend (SPF y DKIM) y un correo de invitación recibido, que no caiga en
      spam.
- [ ] Twilio con cuenta de pago (la de prueba no manda textos propios) y un SMS real recibido.
- [ ] `PRIVACY_NOTICE_VERSION` con el texto que revisó el abogado.
- [ ] `/health/ready` en 200 y configurado en la plataforma.
- [ ] Dueño de la plataforma creado; `piloto.json` corrido; el líder entra y ve su sede.
- [ ] Coordenadas y radio de la sede probados en el lugar (marcar desde la entrada y desde el
      estacionamiento).
- [ ] Una semana de prueba interna: entradas, salidas, correcciones y el Excel revisados con RH.
