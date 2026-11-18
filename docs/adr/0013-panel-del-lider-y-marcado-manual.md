# ADR 0013: Panel del líder, marcado manual y exportación

- Estado: propuesta
- Fecha: 2026-11-18

## Contexto

Semana 3 del plan: el líder necesita ver quién llegó y quién falta en su sede, registrar la entrada o
la salida de quien no pudo marcar (sin teléfono, sin señal, olvidó la salida), y la compañía necesita
las horas en Excel para la nómina. La regla 13 pide comentario y auditoría en todo ajuste manual, y
el registro tiene que distinguir siempre lo que marcó el trabajador de lo que registró el líder.

## Decisión

- **Plantilla de la sede**: quien tiene una asignación vigente de Axeda en esa sede con un rol que
  incluye `attendance:mark` (se decide por permiso, no por nombre de rol). Se lee del esquema `auth`
  con el pool de Better Auth; el panel cruza esa lista con las jornadas del día.
- **Origen en la misma fila**: `attendance_record` gana `check_in_source` / `check_out_source`
  (`self` o `manual`), y para lo manual el autor (`*_by`) y el comentario (`*_comment`). Una entrada
  manual no tiene código (`daily_code_id` pasa a ser opcional). Los CHECK de la base obligan a que lo
  manual tenga autor y comentario, a que lo propio tenga código, y a que nadie se registre a sí mismo
  a mano. No se crea una tabla de "ajustes": la auditoría ya guarda antes y después con el motivo.
- **Marcado manual con `attendance:mark-manual`** (líder y encargado), solo para gente de la
  plantilla de la sede, hasta 7 días atrás, nunca en el futuro y con jornadas de máximo 24 horas.
  Cerrar una "salida pendiente" de otro día es una salida manual con la hora real (obligatoria).
  Cambiar la hora de un marcado ya registrado (`attendance:correct`) queda para después.
- **El panel no decide retardos**: muestra los minutos después de la entrada oficial. La tolerancia
  de cada sede sigue abierta (pregunta 4 del PRD).
- **Calendario**: un día sin jornada es `no-record`, no "falta", porque aún no hay días de descanso
  ni calendario laboral por sede.
- **Excel con `write-excel-file`** (una sola dependencia, `fflate`): hojas "Jornadas" y "Resumen",
  horas en decimal y fechas en la hora local de cada sede. Por sede, negocio o compañía con
  `report:export` (administradores; el líder no). Rango de hasta 62 días. Cada exportación se audita.

## Consecuencias

- El trabajador ve en su jornada y su calendario cuándo algo lo registró el líder, y quién.
- La plantilla depende de Axeda: si a alguien se le quita la asignación, deja de salir como
  "faltante", pero sus jornadas siguen apareciendo (`onRoster: false`).
- El encargado puede cerrar salidas pendientes, porque tiene `attendance:mark-manual`. Si eso debe
  ser solo del líder, se cambia a `attendance:correct` en esa ruta.
