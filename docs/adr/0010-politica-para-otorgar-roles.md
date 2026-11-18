# 0010. Tempora limita qué roles otorga cada nivel

- Status: Accepted
- Date: 2026-11-18
- Deciders: Noel
- Relacionado: ADR 0002, ADR 0007 (riesgo de escalada lateral)

## Context and problem statement

Con Axeda 0.1.0-alpha.2 el líder puede invitar y asignar en su sede (alta de empleados y encargado).
Axeda solo exige que quien otorga tenga `axeda:assignment:manage` o `axeda:invitation:manage` en ese
lugar y cubra los permisos del rol. Un líder cubre el rol de líder, así que podría nombrar a otro líder
llamando directamente a `/api/auth/axeda/...`. Axeda todavía no permite limitar qué roles concede cada
rol (pregunta abierta al equipo de Axeda).

## Decision

Un hook `before` de Better Auth revisa `/axeda/assignment/create`, `/axeda/assignment/revoke` y
`/axeda/invitation/create` antes de que lleguen a Axeda. Calcula el nivel más alto desde el que quien
otorga alcanza ese lugar (sede, negocio, compañía o global) y lo compara con `GRANT_POLICY`:

| Rol                        | Nivel mínimo de quien lo otorga o lo quita |
| -------------------------- | ------------------------------------------ |
| Trabajador, encargado      | Sede                                       |
| Líder, admin. de negocio   | Negocio                                    |
| Admin. de compañía         | Compañía                                   |
| Rol no declarado en código | Compañía                                   |

## Consequences

- Todo acceso a Axeda pasa por la API de Tempora, así que la regla no se puede saltar desde el frontend.
- Si Axeda agrega un límite propio, este hook se puede retirar.
- Una revocación se revisa con el rol y el lugar leídos de la base, no del cliente.

## Confirmation

`test/api.e2e-spec.ts`, "Quién otorga qué": el líder invita trabajadores y designa encargado en su sede;
no puede invitar ni asignar líderes o administradores, ni quitar a otro líder. Sin el hook, esas pruebas
fallan.
