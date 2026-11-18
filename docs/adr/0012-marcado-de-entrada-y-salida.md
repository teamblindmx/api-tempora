# ADR 0012: Marcado de entrada y salida

- Estado: propuesta
- Fecha: 2026-11-18

## Contexto

Semana 2 del plan: código diario por sede, entrada validada con la ubicación y salida, con auditoría.
Las reglas de jornada (1 a 8) piden que la hora la ponga el servidor, que la ubicación nunca rechace un
marcado y que la salida se clasifique contra el cierre. El horario oficial de cada sede aún no está
definido (pregunta abierta 4 del PRD).

## Decisión

- Código de 6 dígitos, generado por quien tiene `daily-code:show` en la sede (líder o encargado), con
  vigencia de 20 a 30 minutos. Generar uno nuevo vence el anterior. Se guarda en `app.daily_code` y
  cada jornada apunta al código con que se marcó.
- Una tabla `app.attendance_record` con una fila por trabajador y día de jornada (fecha local de la
  sede al entrar), con entrada y salida en la misma fila. Turnos que cruzan la medianoche se cierran al
  día siguiente.
- "Por revisar" es una lista de motivos (`review_reasons`), no un estado único: una jornada puede
  tener varios a la vez y el panel del líder los muestra.
- Horario opcional por sede (`shift_start`, `shift_end`, "HH:MM" en su zona). Sin horario, la salida
  no se clasifica por horario.
- La hora sale de un `Clock` inyectable; las pruebas la fijan.
- Tope de 10 intentos de entrada por usuario y minuto con `@nestjs/throttler`, en memoria.

## Consecuencias

- Sin `DELETE` para la API en estas tablas; las correcciones del líder (semana 3) se auditan.
- El tope de intentos vive en memoria: con más de una instancia de la API habría que moverlo a un
  almacén compartido.
- Un trabajador no puede tener dos jornadas el mismo día (turnos partidos). Si hiciera falta, se cambia
  el índice único y la búsqueda de la jornada abierta.
