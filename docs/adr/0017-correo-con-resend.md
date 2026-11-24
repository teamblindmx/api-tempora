# ADR 0017: Correo con Resend

- Estado: aceptada (Noel eligió Resend el 2026-11-23)
- Fecha: 2026-11-23

## Contexto

La API manda dos correos: la verificación de la cuenta al registrarse con correo y las invitaciones
por correo (Axeda). Hasta ahora solo se imprimían en la consola, así que en producción el dueño
tenía que buscar su enlace en los registros y no se podía invitar a nadie por correo (ADR 0016).

## Decisión

- `MAIL_PROVIDER`: `console` (por omisión, desarrollo) o `resend`. En producción la API no arranca
  con `console`, igual que con el SMS. Con `resend` hacen falta `RESEND_API_KEY` (`re_...`) y
  `MAIL_FROM` (`correo` o `Nombre <correo>`, con el dominio verificado en Resend); `MAIL_REPLY_TO` es
  opcional. Si falta algo, la API no arranca y dice qué.
- `src/auth/mail/resend.ts` llama a `POST https://api.resend.com/emails` con `fetch`, sin el SDK: es
  una llamada, como Twilio, y no agrega dependencias. 10 segundos como máximo. Un rechazo se vuelve
  `MailSendError` con el HTTP y el tipo de error de Resend, nunca el destinatario ni el enlace.
- `src/auth/mail/templates.ts`: los dos correos en español, en texto y HTML sencillo (sin imágenes ni
  rastreo), solo con el enlace. El enlace va escapado en el HTML.
- No se manda nada a los correos de relleno de quien entró por teléfono (`@phone.invalid`).
- `npm run pilot:setup` manda las invitaciones por correo con el proveedor configurado; con
  `--solo-enlaces` no manda nada y solo las imprime.

## Consecuencias

- Antes del piloto hay que verificar el dominio en Resend (registros SPF y DKIM en el DNS) y crear una
  llave de solo envío. Sin dominio verificado, Resend rechaza los envíos.
- Un envío fallido no se reintenta: la persona pide otro correo de verificación o se le reenvía la
  invitación (`--reenviar`).
- Cuando haya restablecimiento de contraseña por correo, su texto va en `templates.ts` y se agrega al
  `Mailer`.
