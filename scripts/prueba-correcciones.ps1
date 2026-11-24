# Prueba manual de corrección de horas, revisión de jornadas "por revisar" y avisos al líder (ADR 0015).
# PowerShell 5.1 o 7, en Windows.
#
# Antes, en otra terminal, en la carpeta tempora-api:
#   docker compose up -d
#   npm run db:generate
#   npm run db:migrate          <- aplica la migración nueva (correcciones_revision_y_avisos)
#   npm run start:dev           <- deja esta terminal abierta: ahí salen los correos y SMS de desarrollo
#
# Luego, en esta terminal y en la misma carpeta:
#   powershell -ExecutionPolicy Bypass -File .\scripts\prueba-correcciones.ps1
#
# El trabajador marca lejos de la sede y sale una hora después del cierre, así que su jornada queda
# "por revisar" y el líder recibe un aviso. Para no esperar, la sede tiene un horario que empezó hace
# 3 horas y cerró hace 1 hora (hora de CDMX). Córrelo entre las 04:00 y las 23:00.
# El administrador hace también de líder (tiene todos los permisos de su compañía).

param(
  [string]$Email = 'admin@tempora.test',
  [string]$Password = 'contrasena-larga-123',
  [string]$Phone = '+523312345680',
  [string]$PrivacyVersion = '2026-11-borrador',   # el PRIVACY_NOTICE_VERSION de tu .env
  [double]$SiteLat = 20.676667,
  [double]$SiteLng = -103.347222
)

$ErrorActionPreference = 'Stop'
$B = 'http://localhost:3000'
$H = @{ Origin = 'http://localhost:5173' }   # sin Origin de confianza, las escrituras con cookie dan 403

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
function TryCall($method, $path, $session, $body) {
  try { Call $method $path $session $body } catch { Write-Host '  (error esperado, el script sigue)' -ForegroundColor Yellow }
}
function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Show($obj) { $obj | ConvertTo-Json -Depth 8 }

# Hora actual en CDMX (Windows usa el id "Central Standard Time (Mexico)"; PowerShell 7 acepta el IANA).
function MexicoNow {
  foreach ($id in @('Central Standard Time (Mexico)', 'America/Mexico_City')) {
    try { return [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, $id) } catch { }
  }
  throw 'No encontré la zona horaria de CDMX'
}
# Un instante en UTC, minutos desde ahora, como lo pide la API ("2026-12-08T14:05:00Z").
function UtcIso([double]$minutesFromNow) {
  [DateTime]::UtcNow.AddMinutes($minutesFromNow).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
}
function Record($r) {
  $r | Select-Object checkInAt, checkOutAt, late, lateMinutes, checkOutKind, needsReview,
    @{ n = 'reviewReasons'; e = { $_.reviewReasons -join ', ' } },
    @{ n = 'reviewedReasons'; e = { $_.reviewedReasons -join ', ' } }, correctedAt | Format-List
}

$admin = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$worker = New-Object Microsoft.PowerShell.Commands.WebRequestSession

Step '1. Administrador (si ya existe de las otras pruebas, el registro falla y se sigue)'
TryCall Post '/api/auth/sign-up/email' $admin @{ email = $Email; password = $Password; name = 'Admin' } | Out-Null
Write-Host 'Si es nuevo: abre el enlace "[correo de desarrollo] Verificación..." de la consola de la API.'
Read-Host 'Enter para seguir' | Out-Null
npm run bootstrap:admin -- $Email
$signIn = Call Post '/api/auth/sign-in/email' $admin @{ email = $Email; password = $Password }
$adminId = [string]$signIn.user.id

Step '2. Compañía y sede nuevas; el administrador queda como administrador de SU compañía'
$suffix = Get-Random -Maximum 99999
$company = Call Post '/api/auth/axeda/company/create' $admin @{ slug = "acme-$suffix"; name = 'Acme Industrial' }
$site = Call Post '/api/auth/axeda/site/create' $admin @{ companyId = $company.id; slug = 'gdl'; name = 'Guadalajara' }
$roles = (Call Get '/api/auth/axeda/role/list?limit=100' $admin).items
$role = @{}; foreach ($r in $roles) { $role[$r.key] = $r.id }
Call Post '/api/auth/axeda/assignment/create' $admin @{
  userId = $adminId; roleId = $role['company-admin']; scope = @{ type = 'company'; id = $company.id }
} | Out-Null
$S = "/sites/$($site.id)"
Write-Host "Compañía $($company.id)  Sede $($site.id)"

Step '3. Horario de la sede: empezó hace 3 h y cerró hace 1 h; radio de 300 m'
$mx = MexicoNow
$start = $mx.AddHours(-3).ToString('HH:mm'); $end = $mx.AddHours(-1).ToString('HH:mm')
Call Put $S $admin @{
  latitude = $SiteLat; longitude = $SiteLng; radiusM = 300
  shiftStart = $start; shiftEnd = $end; lateToleranceMin = 10; restDays = @(0)
} | Out-Null
Write-Host "Horario $start a $end"

Step '4. Invitar al trabajador por teléfono, que entre y acepte el aviso de privacidad'
Call Post '/api/auth/axeda/invitation/create' $admin @{
  phoneNumber = $Phone; scope = @{ type = 'site'; id = $site.id }; roleIds = @($role['worker'])
} | Out-Null
$token = Read-Host 'Pega el token de la invitación (lo que va después de token= en el SMS de la consola)'
Call Post '/api/auth/phone-number/send-otp' $worker @{ phoneNumber = $Phone } | Out-Null
$otp = Read-Host 'Pega el código de 6 dígitos del SMS de desarrollo'
Call Post '/api/auth/phone-number/verify' $worker @{ phoneNumber = $Phone; code = $otp } | Out-Null
Call Post '/api/auth/axeda/invitation/accept' $worker @{ token = $token } | Out-Null
Call Post "$S/privacy-notice/accept" $worker @{ version = $PrivacyVersion } | Out-Null

Step '5. El trabajador marca a unos 5 km de la sede: no se rechaza, queda "por revisar" (y con retardo)'
$code = Call Post "$S/daily-code" $admin @{}
$rec = Call Post "$S/attendance/check-in" $worker @{
  code = $code.code; location = @{ latitude = $SiteLat + 0.045; longitude = $SiteLng; accuracyM = 15 }
}
Record $rec

Step '6. El líder ve el aviso de la sede'
$n = Call Get "$S/notices" $admin
Write-Host "Pendientes: $($n.open)"
$n.items | Select-Object kind, workDate, @{ n = 'persona'; e = { $_.person.phoneNumber } }, @{ n = 'detalle'; e = { $_.detail -join ', ' } } | Format-Table -AutoSize

Step '7. Sale sin ubicación, 1 h después del cierre: el MISMO aviso suma los motivos nuevos'
$out = Call Post "$S/attendance/check-out" $worker @{ location = $null }
Record $out
(Call Get "$S/notices" $admin).items | Select-Object kind, @{ n = 'detalle'; e = { $_.detail -join ', ' } }, updatedAt | Format-Table -AutoSize

Step '8. Lista de jornadas por revisar'
(Call Get "$S/attendance/review" $admin).items | Select-Object @{ n = 'fecha'; e = { $_.record.workDate } }, @{ n = 'pendiente'; e = { $_.pendingReasons -join ', ' } } | Format-Table -AutoSize

Step '9. El trabajador no puede corregir ni revisar (403), ni ver los avisos'
TryCall Post "$S/attendance/records/$($rec.id)/correct" $worker @{ checkInAt = (UtcIso -170); comment = 'Me corrijo yo' }
TryCall Post "$S/attendance/records/$($rec.id)/review" $worker @{}
TryCall Get "$S/notices" $worker $null

Step '10. Correcciones imposibles: sin comentario (400), hora del futuro (422)'
TryCall Post "$S/attendance/records/$($rec.id)/correct" $admin @{ checkInAt = (UtcIso -170) }
TryCall Post "$S/attendance/records/$($rec.id)/correct" $admin @{ checkInAt = (UtcIso 30); comment = 'Una hora del futuro' }

Step '11. El líder corrige la entrada: llegó 5 min después de la entrada oficial -> ya no es retardo'
Record (Call Post "$S/attendance/records/$($rec.id)/correct" $admin @{
  checkInAt = (UtcIso -175); comment = 'Llegó a tiempo, el código tardó en salir'
})

Step '12. Corrige la salida a 5 min después del cierre -> ya no está "fuera de horario"'
Record (Call Post "$S/attendance/records/$($rec.id)/correct" $admin @{
  checkOutAt = (UtcIso -55); comment = 'Salió al cierre, marcó al llegar a la parada'
})

Step '13. Detalle de la jornada con su historial de correcciones (valor anterior y nuevo)'
(Call Get "$S/attendance/records/$($rec.id)" $admin).corrections |
  Select-Object correctedAt, checkInBefore, checkInAfter, checkOutBefore, checkOutAfter, comment | Format-List

Step '14. El líder revisa lo que queda (ubicación) con un comentario: el aviso se atiende solo'
Record (Call Post "$S/attendance/records/$($rec.id)/review" $admin @{ comment = 'Estaba en el almacén externo' })
Write-Host "Avisos pendientes: $((Call Get "$S/notices" $admin).open)"
TryCall Post "$S/attendance/records/$($rec.id)/review" $admin @{}   # 409: ya no hay nada por revisar

Step '15. Avisos del último mes, también los atendidos'
(Call Get "$S/notices?status=all" $admin).items | Select-Object kind, readAt, @{ n = 'detalle'; e = { $_.detail -join ', ' } } | Format-Table -AutoSize

Step '16. Excel de la sede (hoy): columnas "Por revisar", "Revisado" y "Corregida"'
$today = $rec.workDate
$file = Join-Path (Get-Location) "tempora-correcciones-$today.xlsx"
Invoke-WebRequest -Uri "$B$S/attendance/export?from=$today&to=$today" -WebSession $admin -Headers $H -OutFile $file
Write-Host "Guardado en $file" -ForegroundColor Green

Step '17. Auditoría de la compañía'
Call Get "/companies/$($company.id)/audit?limit=25" $admin |
  Select-Object occurredAt, action, targetType, reason | Format-Table -AutoSize
