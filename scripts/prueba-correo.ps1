# Prueba manual del correo con Resend (ADR 0017). PowerShell 5.1 o 7, en Windows.
#
# Antes, en tu .env:
#   MAIL_PROVIDER=resend
#   RESEND_API_KEY=re_...                       <- llave de Resend con permiso de envío
#   MAIL_FROM=Tempora <no-responder@tu-dominio>  <- con el dominio verificado en Resend
#   (Sin dominio verificado, Resend solo deja mandar desde onboarding@resend.dev y solo a tu propio
#   correo, el de tu cuenta de Resend: sirve para esta prueba.)
#
# En otra terminal, en la carpeta tempora-api:
#   docker compose up -d
#   npm run start:dev
#
# Luego, en esta terminal y en la misma carpeta:
#   powershell -ExecutionPolicy Bypass -File .\scripts\prueba-correo.ps1 -To tu@correo.com

param(
  [Parameter(Mandatory = $true)][string]$To,
  [string]$Password = 'contrasena-larga-123'
)

$ErrorActionPreference = 'Stop'
$B = 'http://localhost:3000'
$H = @{ Origin = 'http://localhost:5173' }

function Call($method, $path, $session, $body) {
  $p = @{ Method = $method; Uri = "$B$path"; Headers = $H; WebSession = $session }
  if ($null -ne $body) {
    $p.ContentType = 'application/json; charset=utf-8'
    $p.Body = ($body | ConvertTo-Json -Depth 8 -Compress)
  }
  try { Invoke-RestMethod @p }
  catch {
    Write-Host "  $method $path -> $($_.ErrorDetails.Message)" -ForegroundColor Red
    throw
  }
}
function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }

Step "1. Registro con $To: Resend manda el correo de verificación"
$s = New-Object Microsoft.PowerShell.Commands.WebRequestSession
try {
  Call Post '/api/auth/sign-up/email' $s @{ email = $To; password = $Password; name = 'Prueba de correo' } | Out-Null
  Write-Host 'Revisa tu bandeja (y spam): asunto "Tempora: confirma tu correo". Abre el enlace.'
}
catch {
  Write-Host 'Ese correo ya tiene cuenta: pido que se reenvíe la verificación.' -ForegroundColor Yellow
  Call Post '/api/auth/send-verification-email' $s @{ email = $To } | Out-Null
  Write-Host 'Si la cuenta no estaba verificada, llega otro "Tempora: confirma tu correo".'
}
Write-Host 'Si no llega nada, mira la consola de la API: un rechazo de Resend sale como MailSendError con su tipo'
Write-Host '(p. ej. validation_error si el dominio de MAIL_FROM no está verificado).'
Read-Host 'Enter cuando lo hayas recibido' | Out-Null

Step '2. Inicio de sesión ya verificado'
$in = Call Post '/api/auth/sign-in/email' $s @{ email = $To; password = $Password }
Write-Host "Verificado: $($in.user.emailVerified)"

Write-Host "`nListo. Las invitaciones por correo salen igual: npm run pilot:setup con una persona con email." -ForegroundColor Green
