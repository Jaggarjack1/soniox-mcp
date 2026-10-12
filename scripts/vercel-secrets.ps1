# Uploads the two secrets to the Vercel project and pulls the Blob token into the local .env.
# Values are read from files and piped to the CLI; nothing is echoed to the console.
# Run from the repo root:  .\scripts\vercel-secrets.ps1
$ErrorActionPreference = "Stop"
$scope = "sasos-projects-680c5e68"
# The Claude desktop terminal runs with a virtualised AppData; point the CLI at the real one so it finds the login.
$realAppData = Join-Path $env:USERPROFILE "AppData\Roaming"
if ($env:APPDATA -ne $realAppData -and (Test-Path (Join-Path $realAppData "com.vercel.cli"))) { $env:APPDATA = $realAppData }
if (-not $env:NODE_EXTRA_CA_CERTS -and (Test-Path "C:\ProgramData\AVG\Antivirus\wscert.pem")) {
  $env:NODE_EXTRA_CA_CERTS = "C:\ProgramData\AVG\Antivirus\wscert.pem"   # AVG TLS inspection
}

$auth = Get-Content -Raw -Encoding UTF8 "soniox-auth.json" | ConvertFrom-Json
$mcpToken = (Get-Content ".env" | Where-Object { $_ -match "^MCP_AUTH_TOKEN=" }) -replace "^MCP_AUTH_TOKEN=", ""
if (-not $auth.refreshToken -or -not $mcpToken) { throw "Missing refreshToken in soniox-auth.json or MCP_AUTH_TOKEN in .env" }

Write-Host "Adding SONIOX_REFRESH_TOKEN (production)..."
$auth.refreshToken | npx vercel env add SONIOX_REFRESH_TOKEN production --sensitive --force --scope $scope | Select-Object -Last 1
Write-Host "Adding MCP_AUTH_TOKEN (production)..."
$mcpToken | npx vercel env add MCP_AUTH_TOKEN production --sensitive --force --scope $scope | Select-Object -Last 1

Write-Host "Pulling production env to merge BLOB_READ_WRITE_TOKEN into .env..."
npx vercel env pull .env.vercel --environment production --yes --scope $scope | Select-Object -Last 1
if (-not (Test-Path ".env.vercel")) { throw "env pull failed (no .env.vercel written); is the CLI logged in?" }
$pulled = @{}
Get-Content ".env.vercel" | ForEach-Object { if ($_ -match '^([A-Z0-9_]+)="?(.*?)"?$') { $pulled[$matches[1]] = $matches[2] } }
Remove-Item ".env.vercel" -Force

# Secret-type vars come back as "[SENSITIVE]", so take the refresh token from the local file instead.
$pulled["SONIOX_REFRESH_TOKEN"] = $auth.refreshToken
$envLines = Get-Content ".env"
foreach ($k in @("BLOB_READ_WRITE_TOKEN", "SONIOX_REFRESH_TOKEN")) {
  if (-not $pulled[$k] -or $pulled[$k] -eq "[SENSITIVE]") { Write-Warning "$k not available"; continue }
  $line = "$k=$($pulled[$k])"
  if ($envLines -match "^#? ?$k=") { $envLines = $envLines | ForEach-Object { if ($_ -match "^#? ?$k=") { $line } else { $_ } } }
  else { $envLines += $line }
}
$envLines | Set-Content ".env" -Encoding UTF8
Write-Host "Done. .env now has:" (($envLines | Where-Object { $_ -match '^[A-Z0-9_]+=' }) -replace '=.*', '') -join ", "
