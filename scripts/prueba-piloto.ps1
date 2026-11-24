# Prueba manual de la semana 8 (ADR 0016): salud con base de datos, alta del piloto desde un archivo
# y topes de intentos que no se saltan cambiando X-Forwarded-For. PowerShell 5.1 o 7, en Windows.
#
# Antes, en otra terminal, en la carpeta tempora-api:
#   docker compose up -d
#   npm install                 <- prisma pasó a dependencias (lo usa la imagen de producción)
#   npm run db:migrate
#   npm run start:dev           <- deja esta terminal abierta: ahí salen los correos y SMS de desarrollo
#
# Deja TRUST_PROXY vacío en tu .env (como en .env.example) para el paso 6.
#
# Luego, en esta terminal y en la misma carpeta:
#   powershell -ExecutionPolicy Bypass -File .\scripts\prueba-piloto.ps1
# Con -Docker también construye la imagen de producción y la prueba (tarda unos minutos).

param(
  [string]$Email = 'admin@tempora.test',
  [string]$Password = 'contrasena-larga-123',
  [string]$LeaderPhone = '+523312345681',
  [string]$WorkerPhone = '+523312345682',
  [switch]$Docker
)

$ErrorActionPreference = 'Stop'
$B = 'http://localhost:3000'
$H = @{ Origin = 'http://localhost:5173' }   # sin Origin de confianza, las escrituras con cookie dan 403

function Call($method, $path, $session, $body, $headers = @{}) {
  $p = @{ Method = $method; Uri = "$B$path"; Headers = ($H + $headers); WebSession = $session }
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
# Código HTTP de una petición, sin cortar el script si es un error.
function Status($method, $path, $body, $headers = @{}) {
  $p = @{ Method = $method; Uri = "$B$path"; Headers = ($H + $headers); ContentType = 'application/json; charset=utf-8' }
  if ($null -ne $body) { $p.Body = ($body | ConvertTo-Json -Depth 8 -Compress) }
  try { (Invoke-WebRequest @p -UseBasicParsing).StatusCode }
  catch { [int]$_.Exception.Response.StatusCode }
}
function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }

Step '1. Salud: /health (el proceso responde) y /health/ready (además, las dos conexiones a la base)'
Invoke-RestMethod "$B/health" | ConvertTo-Json -Compress
Invoke-RestMethod "$B/health/ready" | ConvertTo-Json -Compress

$admin = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$leader = New-Object Microsoft.PowerShell.Commands.WebRequestSession

Step '2. Dueño de la plataforma (si ya existe de las otras pruebas, el registro falla y se sigue)'
TryCall Post '/api/auth/sign-up/email' $admin @{ email = $Email; password = $Password; name = 'Admin' } | Out-Null
Write-Host 'Si es nuevo: abre el enlace "[correo de desarrollo] Verificación..." de la consola de la API.'
Read-Host 'Enter para seguir' | Out-Null
npm run bootstrap:admin -- $Email

Step '3. Archivo del piloto: compañía, negocio, sede con horario, festivos y dos personas'
$suffix = Get-Random -Maximum 99999
$pilot = [ordered]@{
  owner    = $Email
  company  = @{ slug = "piloto-$suffix"; name = 'Empresa Piloto SA de CV' }
  business = @{ slug = 'manufactura'; name = 'Manufactura' }
  site     = [ordered]@{
    slug     = 'planta-gdl'
    name     = 'Planta Guadalajara'
    settings = [ordered]@{
      latitude = 20.676667; longitude = -103.347222; radiusM = 200; timezone = 'America/Mexico_City'
      shiftStart = '08:00'; shiftEnd = '17:00'; lateToleranceMin = 10; restDays = @(0)
    }
  }
  holidayYears       = @(2026, 2027)
  invitationTtlHours = 168
  people             = @(
    @{ phoneNumber = $LeaderPhone; role = 'leader' },
    @{ phoneNumber = $WorkerPhone; role = 'worker' }
  )
}
$file = Join-Path $env:TEMP "piloto-$suffix.json"
# PowerShell 5.1 guarda UTF-8 con BOM; el comando lo acepta igual.
$pilot | ConvertTo-Json -Depth 8 | Set-Content -Path $file -Encoding UTF8
Write-Host "Archivo: $file (ejemplo completo en docs\runbooks\piloto.example.json)"

Step '4. Alta del piloto (primera vez: crea todo e invita; los enlaces salen aquí abajo)'
npm run pilot:setup -- $file | Tee-Object -Variable lines
if ($LASTEXITCODE -ne 0) { throw 'pilot:setup falló' }
$first = $lines -join "`n"
$siteId = [regex]::Match($first, 'Sede planta-gdl: creada \(([^)]+)\)').Groups[1].Value
$token = [regex]::Match($first, [regex]::Escape($LeaderPhone) + ':.*token=(\S+)').Groups[1].Value
if (-not $siteId -or -not $token) { throw 'No encontré la sede o el enlace del líder en la salida' }

Step '5. Otra vez el mismo archivo: no duplica nada ni manda invitaciones de nuevo'
npm run pilot:setup -- $file
if ($LASTEXITCODE -ne 0) { throw 'pilot:setup falló' }

Step '5b. El líder entra con su teléfono y acepta la invitación (el token se tomó del paso 4)'
Call Post '/api/auth/phone-number/send-otp' $leader @{ phoneNumber = $LeaderPhone } | Out-Null
$otp = Read-Host 'Pega el código de 6 dígitos del SMS de desarrollo (en la consola de la API)'
Call Post '/api/auth/phone-number/verify' $leader @{ phoneNumber = $LeaderPhone; code = $otp } | Out-Null
Call Post '/api/auth/axeda/invitation/accept' $leader @{ token = $token } | Out-Null
Write-Host 'El líder ya ve su sede, con la configuración del archivo:'
Call Get "/sites/$siteId" $leader | Select-Object radiusM, timezone, shiftStart, shiftEnd, lateToleranceMin, restDays | Format-List
Call Get "/sites/$siteId/attendance/day" $leader | Out-Null
Write-Host 'Y su panel del día responde (el trabajador aparece cuando acepte su invitación).'

Step '6. Topes de intentos: cambiar X-Forwarded-For ya no sirve para saltárselos'
Write-Host 'Seis inicios de sesión con contraseña mala, cada uno "desde otra IP". Con TRUST_PROXY vacío,'
Write-Host 'la API usa la IP real de la conexión, así que el sexto da 429. (Durante un minuto, los inicios de'
Write-Host 'sesión por correo desde esta máquina también dan 429.)'
$codes = foreach ($i in 1..6) {
  Status Post '/api/auth/sign-in/email' @{ email = "nadie$suffix@tempora.test"; password = 'contrasena-mala-123' } @{ 'X-Forwarded-For' = "198.51.100.$i" }
}
Write-Host "Códigos: $($codes -join ', ')  (se espera 401, 401, 401, 401, 401, 429)"

if ($Docker) {
  Step '7. Imagen de producción: se construye y responde /health'
  docker build -t tempora-api .
  if ($LASTEXITCODE -ne 0) { throw 'docker build falló' }
  docker run --rm --entrypoint id tempora-api -un
  docker run --rm --entrypoint node tempora-api -e "import('./dist/src/cli/pilot.js').then(() => console.log('El código del comando de alta va en la imagen'))"
}

Write-Host "`nListo." -ForegroundColor Green
