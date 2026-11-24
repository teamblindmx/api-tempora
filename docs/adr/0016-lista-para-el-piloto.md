# ADR 0016: Lista para el piloto: proxy de confianza, salud, imagen Docker y alta del piloto

- Estado: propuesta
- Fecha: 2026-11-23

## Contexto

Semana 8 del plan. La jornada está completa para el piloto de mediados de diciembre (ADR 0012 a
0015), pero faltaba lo necesario para correr la API fuera de una computadora: no había imagen ni
guía de despliegue, la salud no probaba la base, dar de alta una compañía era una serie de llamadas a
mano, y la API creía cualquier `X-Forwarded-For`, así que cualquiera podía saltarse los topes de
intentos cambiándolo. Noel eligió (2026-11-23) una plataforma con Docker y PostgreSQL administrado
aparte, en lugar de un servidor propio.

## Decisión

**IP del cliente (`TRUST_PROXY`).** Express resuelve la IP con su opción `trust proxy`, que sale de
`TRUST_PROXY`: vacío (por omisión) = la IP de la conexión; un número = cuántos proxies hay delante;
o una lista de IPs/rangos CIDR. Un middleware, antes de Better Auth, borra la cabecera interna
`x-tempora-client-ip` que mande el cliente y la vuelve a poner con esa IP; Better Auth lee solo esa
(`advanced.ipAddress.ipAddressHeaders`). La auditoría (`actor.ip`) usa la misma IP. En producción
detrás del balanceador de la plataforma, `TRUST_PROXY=1`. Las pruebas e2e usan `true` para simular
clientes distintos; `test/proxy.e2e-spec.ts` prueba que, sin proxy de confianza, ni
`X-Forwarded-For` ni la cabecera interna sirven para saltarse el tope.

**Salud.** `GET /health` sigue diciendo solo que el proceso responde (para reiniciarlo).
`GET /health/ready` además corre `SELECT 1` en las dos conexiones (Prisma y la de Better Auth), con 2
segundos como máximo cada una, y da 503 si alguna falla. No dice por qué falló.

**Imagen Docker.** `Dockerfile` en tres etapas sobre `node:22.22-bookworm-slim` con OpenSSL (lo pide
Prisma Migrate). Se compila con dependencias de desarrollo, se quitan con `npm prune --omit=dev` y la
imagen final corre como el usuario `node`. `prisma` pasó a dependencias porque las migraciones corren
con la misma imagen: `npm run db:migrate:prod` (Prisma y luego Better Auth/Axeda) va como comando
previo al despliegue. El código de los comandos de servidor (`migrate-auth`, `bootstrap-admin`,
`pilot-setup`) se movió a `src/cli/` para que vaya compilado en la imagen; `scripts/*.ts` quedan como
envolturas para desarrollo. CI construye la imagen en cada cambio (trabajo `image`).

**Alta del piloto.** `npm run pilot:setup -- piloto.json` (en la imagen,
`node dist/src/cli/pilot-setup.js`). El archivo, validado con Zod, trae la compañía, el negocio
opcional, la sede con coordenadas, horario, tolerancia y días de descanso, los años de festivos de
ley y las personas (correo o teléfono, y rol: administrador de compañía o de negocio, líder,
trabajador). El comando:

- Busca por slug y crea con Axeda lo que falte, a nombre del dueño de la plataforma (`owner`).
- Guarda la sede y carga los festivos con los mismos servicios de la API (`SitesRepository`,
  `HolidaysService`) y el contexto que pondría `PermissionGuard`: RLS con la compañía y auditoría a
  nombre del dueño.
- A quien ya tiene cuenta le asigna el rol; a los demás los invita. A quien ya tiene una invitación
  vigente con ese rol no le manda otra (Axeda reemplazaría la anterior y mandaría otro mensaje), salvo
  con `--reenviar`.
- Se puede repetir: no duplica nada y la sede queda con la configuración del archivo.
- Con `--solo-enlaces` no manda SMS ni correos: imprime los enlaces para compartirlos a mano.

Necesita los servicios de Nest, que dependen de los metadatos de los decoradores: tsx no los emite,
así que en desarrollo se compila con `tsc` a `dist-cli/` (aparte, para no chocar con `start:dev`).

**Guía.** `docs/runbooks/produccion.md`: base y roles, variables, despliegue, primer arranque,
respaldos y la lista antes del piloto.

## Consecuencias

- Durante el piloto, **una sola instancia**: Better Auth y el tope de marcado cuentan intentos en
  memoria. Para escalar, mover esos contadores a la base.
- El correo de verificación y las invitaciones por correo salen con Resend ([ADR 0017](0017-correo-con-resend.md)).
- Twilio necesita cuenta de pago antes del piloto (la de prueba no manda textos propios).
- Un `TRUST_PROXY` mal puesto se nota: vacío detrás del balanceador hace que todos compartan el tope;
  `true` con la API expuesta deja elegir la IP. La guía pide probarlo después de desplegar.
