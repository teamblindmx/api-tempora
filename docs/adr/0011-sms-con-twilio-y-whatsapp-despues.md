# ADR 0011: SMS con Twilio ahora, WhatsApp de Meta después

- Estado: aceptada
- Fecha: 2026-11-18

## Contexto

Los códigos de acceso por teléfono y las invitaciones por teléfono necesitan un proveedor real. La
consola solo sirve en desarrollo. A la larga se quiere WhatsApp (Meta Cloud API) como canal principal,
porque cuesta menos, pero la cuenta y las plantillas de Meta todavía no están listas.

## Decisión

- Usar Twilio Programmable Messaging para SMS desde ya (`SMS_PROVIDER=twilio`).
- Llamar a la API REST de Twilio con `fetch` en lugar del SDK: es una sola llamada y evita una
  dependencia grande.
- Credenciales solo por variables de entorno. En producción, API key (`SK...`) en lugar del Auth Token.
- Todos los canales pasan por `withFallback`, que los prueba en orden. Cuando llegue WhatsApp va primero
  y Twilio queda de respaldo, para usarlo lo menos posible.
- Los registros no llevan el texto del mensaje ni el destino; solo el canal y el código de error.

## Consecuencias

- Cada SMS cuesta; el tope de envíos por número del preset de Axeda limita el abuso.
- Para México conviene un Messaging Service con remitente registrado.
- Para WhatsApp hará falta una plantilla aprobada por Meta para el código de acceso y otra para la
  invitación; el texto actual (`smsText`) no sirve tal cual para WhatsApp.
