# Prueba manual de retardos, aviso de privacidad, horas extra, justificaciones y festivos (ADR 0014).
# PowerShell 5.1 o 7, en Windows.
#
# Antes, en otra terminal, en la carpeta tempora-api:
#   docker compose up -d
#   npm run db:generate
#   npm run db:migrate          <- aplica la migración nueva (retardos_extras_descansos_y_aviso)
#   npm run start:dev           <- deja esta terminal abierta: ahí salen los correos y SMS de desarrollo
#
# Luego, en esta terminal y en la misma carpeta:
#   powershell -ExecutionPolicy Bypass -File .\scripts\prueba-jornada.ps1
#
# Para que se vea un retardo y horas extra sin esperar, el script pone a la sede un horario que
# empezó hace 3 horas y cerró hace 1 hora (hora de CDMX). Córrelo entre las 04:00 y las 23:00.
# El administrador hace también de líder (tiene todos los permisos de su compañía).

param(
  [string]$Email = 'admin@tempora.test',
  [string]$Password = 'contrasena-larga-123',
  [string]$Phone = '+523312345679',
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

$admin = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$worker = New-Object Microsoft.PowerShell.Commands.WebRequestSession

Step '1. Administrador (si ya existe de prueba-marcado.ps1, el registro falla y se sigue)'
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

Step '3. Horario de la sede: empezó hace 3 h y cerró hace 1 h; tolerancia 10 min; descanso el domingo'
$mx = MexicoNow
$start = $mx.AddHours(-3).ToString('HH:mm'); $end = $mx.AddHours(-1).ToString('HH:mm')
Show (Call Put $S $admin @{
  latitude = $SiteLat; longitude = $SiteLng; radiusM = 300
  shiftStart = $start; shiftEnd = $end; lateToleranceMin = 10; restDays = @(0)
})

Step '4. Invitar al trabajador por teléfono y que entre'
Call Post '/api/auth/axeda/invitation/create' $admin @{
  phoneNumber = $Phone; scope = @{ type = 'site'; id = $site.id }; roleIds = @($role['worker'])
} | Out-Null
$token = Read-Host 'Pega el token de la invitación (lo que va después de token= en el SMS de la consola)'
Call Post '/api/auth/phone-number/send-otp' $worker @{ phoneNumber = $Phone } | Out-Null
$otp = Read-Host 'Pega el código de 6 dígitos del SMS de desarrollo'
$w = Call Post '/api/auth/phone-number/verify' $worker @{ phoneNumber = $Phone; code = $otp }
$workerId = [string]$w.user.id
Call Post '/api/auth/axeda/invitation/accept' $worker @{ token = $token } | Out-Null

Step '5. Sin aceptar el aviso de privacidad no puede marcar (403 TEMPORA_PRIVACY_NOT_ACCEPTED)'
$code = Call Post "$S/daily-code" $admin @{}
TryCall Post "$S/attendance/check-in" $worker @{ code = $code.code }
Show (Call Get "$S/privacy-notice" $worker)

Step '6. Acepta el aviso (una versión distinta da 409; la vigente, 200)'
TryCall Post "$S/privacy-notice/accept" $worker @{ version = 'version-vieja' }
Show (Call Post "$S/privacy-notice/accept" $worker @{ version = $PrivacyVersion })

Step '7. "Entrada tardía" con un código vigente no se permite; la entrada normal queda como retardo'
TryCall Post "$S/attendance/late-check-in" $worker @{ code = $code.code }
$rec = Call Post "$S/attendance/check-in" $worker @{
  code = $code.code; location = @{ latitude = 20.6768; longitude = -103.3474; accuracyM = 15 }
}
$rec | Select-Object workDate, checkInAt, late, lateMinutes, checkInCodeExpired | Format-List

Step '8. Panel del líder: tipo de día y retardos del día'
$panel = Call Get "$S/attendance/day" $admin
$panel | Select-Object date, lateToleranceMin, @{ n = 'day'; e = { $_.day | ConvertTo-Json -Compress } } | Format-List
$panel.summary | Format-List

Step '9. Horas extra: ya pasó el cierre; sin autorización, todo es tiempo no autorizado'
(Call Get "$S/attendance/me" $worker).record.overtime | Format-List

Step '10. El líder autoriza en vivo una jornada abierta (until = null)'
$ot = Call Post "$S/overtime" $admin @{ userId = $workerId; until = $null; reason = 'Pedido urgente del cliente' }
Show $ot
(Call Get "$S/attendance/me" $worker).record.overtime | Select-Object inProgress, extraMinutes, authorizedMinutes, unauthorizedMinutes | Format-List

Step '11. El trabajador no puede autorizarse horas extra (403)'
TryCall Post "$S/overtime" $worker @{ userId = $workerId; reason = 'Me autorizo yo' }

Step '12. El líder cierra la jornada abierta; espera 1 minuto y sale: ese minuto es no autorizado'
Show (Call Post "$S/overtime/$($ot.id)/close" $admin $null)
Write-Host 'Esperando 65 segundos...' -ForegroundColor DarkGray
Start-Sleep -Seconds 65
$out = Call Post "$S/attendance/check-out" $worker @{ location = @{ latitude = 20.6768; longitude = -103.3474 } }
$out.overtime | Select-Object scheduledEnd, extraMinutes, authorizedMinutes, unauthorizedMinutes | Format-List
Write-Host "reviewReasons: $($out.reviewReasons -join ', ')"

Step '13. Después de la salida ya no se autorizan horas extra (409 TEMPORA_OVERTIME_AFTER_EXIT)'
TryCall Post "$S/overtime" $admin @{ userId = $workerId; reason = 'Tarde para autorizar' }

Step '14. El trabajador justifica su retardo; el líder lo ve y lo aprueba'
$today = $rec.workDate
$j = Call Post "$S/justifications" $worker @{ workDate = $today; kind = 'late'; reason = 'Se descompuso el camión' }
Show $j
TryCall Post "$S/justifications" $worker @{ workDate = $today; kind = 'late'; reason = 'Otra vez' }   # 409: una por día y tipo
(Call Get "$S/justifications?status=pending" $admin).items | Select-Object workDate, kind, status, reason, @{ n = 'persona'; e = { $_.person.name } } | Format-Table -AutoSize
TryCall Post "$S/justifications/$($j.id)/reject" $admin @{}   # 400: rechazar pide comentario
Show (Call Post "$S/justifications/$($j.id)/approve" $admin @{ comment = 'Hubo bloqueo en la carretera' })

Step '15. Festivos: los de la LFT de 2027 para toda la compañía y uno solo de la sede'
(Call Post "/companies/$($company.id)/holidays/statutory" $admin @{ year = 2027 }).items | Select-Object date, name, source | Format-Table -AutoSize
Call Post "$S/holidays" $admin @{ date = '2027-12-12'; name = 'Virgen de Guadalupe' } | Out-Null
(Call Get "$S/holidays?year=2027" $admin).items | Select-Object date, name, siteId | Format-Table -AutoSize

Step '16. Calendario del trabajador: tipo de cada día, justificaciones y totales'
$cal = Call Get "$S/attendance/me/calendar" $worker
$cal.days | Where-Object { $_.date -le $today } | Select-Object -Last 7 date, dayType, sunday, status, @{ n = 'justif.'; e = { ($_.justifications | ForEach-Object { "$($_.kind):$($_.status)" }) -join ' ' } } | Format-Table -AutoSize
$cal.totals | Format-List

Step '17. Excel de la sede (hoy): columnas de tipo de día, retardo, horas extra y justificaciones'
$file = Join-Path (Get-Location) "tempora-jornada-$today.xlsx"
Invoke-WebRequest -Uri "$B$S/attendance/export?from=$today&to=$today" -WebSession $admin -Headers $H -OutFile $file
Write-Host "Guardado en $file" -ForegroundColor Green

Step '18. Auditoría de la compañía'
Call Get "/companies/$($company.id)/audit?limit=25" $admin |
  Select-Object occurredAt, action, targetType, reason | Format-Table -AutoSize
