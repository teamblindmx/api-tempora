# 0009. NestJS 12 sobre Express 5 para la API

- Status: Accepted
- Date: 2026-11-17
- Deciders: Noel
- Supersedes: la parte "Backend: Express 5" del ADR 0006 (el resto del ADR 0006 sigue vigente)

## Context and problem statement

El ADR 0006 eligió Express 5 con TypeScript. El equipo prefiere NestJS, que ya trae TypeScript,
inyección de dependencias y módulos, y que corre sobre Express. Había que confirmar que el cambio no
afecta lo demás del plan: Prisma 7 con RLS, Better Auth y Axeda, Zod y OpenAPI, y Vitest.

## Decision

NestJS 12 con `@nestjs/platform-express` (Express 5.3), Node 22 y TypeScript 6.0. Versiones exactas
(`--save-exact`), probadas juntas el 2026-11-17 contra PostgreSQL 16:

| Paquete                                    | Versión                |
| ------------------------------------------ | ---------------------- |
| @nestjs/\* (core, common, platform, test)  | 12.5.1                 |
| typescript                                 | 6.0.2                  |
| prisma, @prisma/client, @prisma/adapter-pg | 7.10.1                 |
| better-auth, @better-auth/core             | 1.7.17                 |
| @teamblind/axeda-core, -better-auth        | 0.1.0-alpha.2          |
| nestjs-cls                                 | 7.0.2                  |
| zod / nestjs-zod / @nestjs/swagger         | 4.6.7 / 5.6.0 / 12.1.2 |
| vitest / vite                              | 4.1.2 / 8.3.8          |

Cómo encaja cada pieza:

- **Better Auth** se monta en Express antes de cualquier parser (`bodyParser: false` y después
  `app.useBodyParser('json')`), en `/api/auth`.
- **Axeda**: un guard global de Nest (`PermissionGuard`) usa el núcleo de Axeda (`can`,
  `resolveTarget`, `scopesFor`) con la sesión de Better Auth. Las rutas declaran
  `@RequirePermission(permiso, { company: 'companyId' })`. Se deniega por defecto. No se usa
  `@teamblind/axeda-express` porque sus middlewares no se pueden declarar por ruta en Nest; el guard
  aplica las mismas reglas (CSRF por origen, alcance leído de la base, mismo 403 si no existe).
- **RLS**: el guard guarda la compañía validada en el contexto de la petición (nestjs-cls) y
  `TenantDb.run()` abre la transacción con `set_config('app.company_id', ..., true)`.
- **Zod**: nestjs-zod valida cuerpos y consultas y genera el OpenAPI (`/docs`) desde los mismos esquemas.

## Consequences

- No usar TypeScript 7.0: `nest build` necesita la API de compilador, que TS 7.0 no trae (se espera en
  7.1).
- Better Auth se queda en 1.7.17 (lo que Axeda probó) hasta que Axeda declare otra.
- El generador de Prisma necesita `moduleFormat = "esm"` e `importFileExtension = "js"`; sin eso la
  API compilada no arranca.
- En Vitest no hace falta SWC: Vite 8 emite los metadatos de decoradores. Si se baja a Vite 6 o
  anterior, hay que agregar `unplugin-swc`.
- El dueño de la plataforma (administrador global de Axeda, con `*`) no recibe los permisos de datos de
  clientes: el guard exige que esos permisos vengan de la compañía o del negocio (ADR 0002).

## Confirmation

`npm run test:e2e` (CI): aislamiento entre compañías en la base y por HTTP, 403 entre compañías,
dueño de la plataforma sin acceso a datos de clientes, auditoría de solo inserción.
