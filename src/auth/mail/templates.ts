/**
 * Textos de los correos. Llevan solo el enlace: nada de datos de la persona ni de la compañía, igual
 * que los SMS. Cada correo va en texto y en HTML sencillo (sin imágenes ni rastreo).
 */
export interface Email {
  subject: string;
  text: string;
  html: string;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function layout(title: string, intro: string, action: string, url: string, outro: string): string {
  const href = escapeHtml(url);
  return `<!doctype html>
<html lang="es">
<body style="margin:0;padding:24px;background:#f5f5f4;font-family:Arial,Helvetica,sans-serif;color:#1c1917">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px">
    <h1 style="margin:0 0 16px;font-size:20px">${escapeHtml(title)}</h1>
    <p style="margin:0 0 24px;font-size:15px;line-height:1.5">${escapeHtml(intro)}</p>
    <p style="margin:0 0 24px"><a href="${href}" style="display:inline-block;background:#1c1917;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-size:15px">${escapeHtml(action)}</a></p>
    <p style="margin:0 0 8px;font-size:13px;color:#57534e">Si el botón no funciona, copia este enlace en tu navegador:</p>
    <p style="margin:0 0 24px;font-size:13px;word-break:break-all"><a href="${href}" style="color:#1c1917">${href}</a></p>
    <p style="margin:0;font-size:13px;color:#57534e">${escapeHtml(outro)}</p>
  </div>
</body>
</html>`;
}

export const emailText = {
  verification(url: string): Email {
    const intro = 'Confirma tu correo para terminar de crear tu cuenta de Tempora.';
    const outro = 'El enlace vence en una hora. Si no creaste una cuenta, ignora este correo.';
    return {
      subject: 'Tempora: confirma tu correo',
      text: `${intro}\n\n${url}\n\n${outro}\n`,
      html: layout('Confirma tu correo', intro, 'Confirmar correo', url, outro),
    };
  },
  invitation(url: string): Email {
    const intro = 'Te invitaron a Tempora, el registro de jornada de tu trabajo.';
    const outro = 'Si no esperabas esta invitación, ignora este correo.';
    return {
      subject: 'Tempora: te invitaron',
      text: `${intro} Entra aquí para aceptar:\n\n${url}\n\n${outro}\n`,
      html: layout('Te invitaron a Tempora', intro, 'Aceptar invitación', url, outro),
    };
  },
};
