# Prueba manual del marcado de entrada y salida, paso a paso (PowerShell 5.1 o 7).
#
# Antes, en otra terminal, en la carpeta tempora-api:
#   docker compose up -d
#   npm run db:generate
#   npm run db:migrate
#   npm run start:dev        <- deja esta terminal abierta: ahí salen los correos y SMS de desarrollo
#
# Luego, en esta terminal y en la misma carpeta:
#   powershell -ExecutionPolicy Bypass -File .\scripts\prueba-marcado.ps1
#
# El script se detiene cuando necesita algo que sale en la consola de la API (enlace de verificación,
# token de invitación, código por SMS).

param(
  [string]$Email = 'admin@tempora.test',
  [string]$Password = 'contrasena-larga-123',
  [string]$Phone = '+523312345678',
  # Ubicación de la sede (Catedral de Guadalajara) y radio en metros.
  [double]$SiteLat = 20.676667,
  [double]$SiteLng = -103.347222,
  [int]$RadiusM = 300
)

$ErrorActionPreference = 'Stop'
$B = 'http://localhost:3000'
$H = @{ Origin = 'http://localhost:5173' }   # sin Origin de confianza, las escrituras con cookie dan 403

function Call($method, $path, $session, $body) {
  $p = @{ Method = $method; Uri = "$B$path"; Headers = $H; WebSession = $session }
  if ($null -ne $body) {
    $p.ContentType = 'application/json; charset=utf-8'
    $p.Body = ($body | ConvertTo-Json -Depth 6 -Compress)
  }
  try { Invoke-RestMethod @p }
  catch {
    # Muestra el cuerpo del error de la API (código y mensaje), no solo "(400) Solicitud incorrecta".
    Write-Host "  $method $path -> $($_.ErrorDetails.Message)" -ForegroundColor Red
    throw
  }
}
# Igual que Call, pero muestra el error de negocio (422, 409...) en vez de detener el script.
function TryCall($method, $path, $session, $body) {
  try { Call $method $path $session $body } catch { Write-Host '  (error esperado, el script sigue)' -ForegroundColor Yellow }
}
function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Show($obj) { $obj | ConvertTo-Json -Depth 6 }

$admin = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$worker = New-Object Microsoft.PowerShell.Commands.WebRequestSession

Step '1. Registro del administrador por correo'
Call Post '/api/auth/sign-up/email' $admin @{ email = $Email; password = $Password; name = 'Admin' } | Out-Null
Write-Host 'En la consola de la API sale "[correo de desarrollo] Verificación para ...: http://...".'
Write-Host 'Abre ese enlace en el navegador (si el correo ya estaba verificado, sáltalo).'
Read-Host 'Enter cuando lo hayas abierto' | Out-Null

Step '2. Hacerlo dueño de la plataforma (falla sin problema si ya existe uno)'
npm run bootstrap:admin -- $Email

Step '3. Iniciar sesión'
$signIn = Call Post '/api/auth/sign-in/email' $admin @{ email = $Email; password = $Password }
$adminId = [string]$signIn.user.id
Write-Host "Usuario $adminId"

Step '4. Compañía y sede en Axeda'
$suffix = Get-Random -Maximum 99999
$company = Call Post '/api/auth/axeda/company/create' $admin @{ slug = "acme-$suffix"; name = 'Acme Industrial' }
$site = Call Post '/api/auth/axeda/site/create' $admin @{ companyId = $company.id; slug = 'gdl'; name = 'Guadalajara' }
$roles = (Call Get '/api/auth/axeda/role/list?limit=100' $admin).items
$role = @{}; foreach ($r in $roles) { $role[$r.key] = $r.id }
Write-Host "Compañía $($company.id)  Sede $($site.id)"

Step '5. El dueño de la plataforma no ve datos de nómina: se da rol de administrador en SU compañía'
Call Post '/api/auth/axeda/assignment/create' $admin @{
  userId = $adminId; roleId = $role['company-admin']; scope = @{ type = 'company'; id = $company.id }
} | Out-Null

Step '6. Ubicación, radio y horario de la sede (08:00 a 17:00, hora de CDMX)'
Show (Call Put "/sites/$($site.id)" $admin @{
  latitude = $SiteLat; longitude = $SiteLng; radiusM = $RadiusM; shiftStart = '08:00'; shiftEnd = '17:00'
})

Step '7. Código diario (30 minutos)'
$code = Call Post "/sites/$($site.id)/daily-code" $admin @{}
Write-Host "Código: $($code.code)  vence: $($code.expiresAt)" -ForegroundColor Green

Step '8. Invitar al trabajador por teléfono'
Call Post '/api/auth/axeda/invitation/create' $admin @{
  phoneNumber = $Phone; scope = @{ type = 'site'; id = $site.id }; roleIds = @($role['worker'])
} | Out-Null
Write-Host 'En la consola de la API sale "[SMS de desarrollo] ...invitacion?token=XXXX".'
$token = Read-Host 'Pega el token (lo que va después de token=)'

Step '9. El trabajador entra con su teléfono'
Call Post '/api/auth/phone-number/send-otp' $worker @{ phoneNumber = $Phone } | Out-Null
$otp = Read-Host 'Pega el código de 6 dígitos del SMS de desarrollo'
Call Post '/api/auth/phone-number/verify' $worker @{ phoneNumber = $Phone; code = $otp } | Out-Null
Call Post '/api/auth/axeda/invitation/accept' $worker @{ token = $token } | Out-Null

Step '9b. Aceptar el aviso de privacidad (sin esto, marcar da 403; ver ADR 0014)'
Call Post "/sites/$($site.id)/privacy-notice/accept" $worker @{ version = '2026-11-borrador' } | Out-Null

Step '10. Entrada con un código incorrecto (422) y luego con el bueno, dentro del radio'
$wrong = if ($code.code -eq '000000') { '000001' } else { '000000' }
TryCall Post "/sites/$($site.id)/attendance/check-in" $worker @{ code = $wrong }
Show (Call Post "/sites/$($site.id)/attendance/check-in" $worker @{
  code = $code.code; location = @{ latitude = 20.6768; longitude = -103.3474; accuracyM = 15 }
})

Step '11. Mi jornada de hoy'
Show (Call Get "/sites/$($site.id)/attendance/me" $worker)

Step '12. Salida sin motivo (si es antes de las 16:30 de CDMX, da 422 y pide motivo)'
TryCall Post "/sites/$($site.id)/attendance/check-out" $worker @{ location = @{ latitude = 20.6768; longitude = -103.3474 } }

Step '13. Salida con motivo'
TryCall Post "/sites/$($site.id)/attendance/check-out" $worker @{
  location = @{ latitude = 20.6768; longitude = -103.3474 }; reason = 'Prueba de salida'
} | ConvertTo-Json -Depth 6

Step '14. Auditoría de la compañía'
Call Get "/companies/$($company.id)/audit?limit=10" $admin |
  Select-Object occurredAt, action, targetType, actorUserId | Format-Table -AutoSize

Write-Host "`nPara ver la entrada fuera del radio: corre otra vez con otro -Phone y cambia la ubicación del paso 10 por" -ForegroundColor Cyan
Write-Host '20.676944, -103.3425 (Teatro Degollado, ~500 m): queda needsReview = true, entry:outside-radius.' -ForegroundColor Cyan
