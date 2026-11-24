# Reglas de jornada

Funciones puras: sin Nest, sin Prisma, sin reloj ni red. Reciben todo lo que necesitan (incluida la
hora, que siempre pone el servidor) y devuelven un resultado. Se prueban con Vitest sin base de datos.

La fuente es "Reglas de jornada" en la documentación del proyecto. Las reglas de pago no están
validadas por un laboralista: aquí solo se calculan horas, nunca dinero (regla 17).

| Archivo            | Reglas                                                                      |
| ------------------ | --------------------------------------------------------------------------- |
| `location.ts`      | 3 y 4: radio de la sede, "por revisar" en vez de rechazar                   |
| `exit.ts`          | 6 y 8: salida normal o anticipada, revisión por diferencia de horario       |
| `workday.ts`       | 1: día de jornada y horario en la zona de la sede                           |
| `marking.ts`       | 2, 3, 6, 7 y 8 juntas: qué queda "por revisar" en una entrada o salida      |
| `overtime.ts`      | 9: minutos autorizados y no autorizados; 15: dobles y triples (aún sin uso) |
| `lateness.ts`      | 10: retardo con tolerancia de la sede y entrada tardía                      |
| `calendar.ts`      | 15 y 16: día ordinario, domingo, descanso o festivo; festivos de la LFT     |
| `justification.ts` | 12: qué se puede justificar y cuándo                                        |
| `manual.ts`        | 13: límites del marcado manual del líder (hasta 7 días, máximo 24 h)        |
| `panel.ts`         | Panel del líder, calendario y rango de exportación                          |
