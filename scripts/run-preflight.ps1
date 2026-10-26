<#
.SYNOPSIS
  Runs the read-only LeadFlow production preflight as leadflow_preflight,
  without the password ever appearing in a command, file in Git, history,
  log or console.

.DESCRIPTION
  The role password is kept in a DPAPI-encrypted file that only THIS Windows
  user on THIS computer can decrypt (created once with -SavePassword). Each
  run decrypts it in memory, builds PREFLIGHT_DATABASE_URL for this process
  only, runs scripts/verify-preflight-role.mjs, and runs the preflight ONLY
  if the role is verified read-only. The variable is removed afterwards.

.EXAMPLE
  # Once: store the leadflow_preflight password (typed, not echoed)
  .\scripts\run-preflight.ps1 -SavePassword

  # Before the release
  .\scripts\run-preflight.ps1

  # After deploying #11 / #12
  .\scripts\run-preflight.ps1 -After 11
#>
param(
  [switch]$SavePassword,
  [ValidateSet('', '11', '12')] [string]$After = '',
  [string]$DbHost = 'acela.proxy.rlwy.net',
  [int]$Port = 17722,
  [string]$Database = 'railway',
  [string]$Role = 'leadflow_preflight',
  # verify-ca: trust ONLY this database's own root certificate (pinned in the
  # repository). verify-full is impossible against Railway's proxy: its
  # certificate names localhost / postgres-17.railway.internal, not the proxy
  # host, and no public CA signs it. 'require' (encrypt, no identity check) is
  # a fallback for when the pinned certificate no longer matches; 'disable' is
  # for local test databases only.
  [ValidateSet('verify-ca', 'require', 'disable')] [string]$SslMode = 'verify-ca',
  [string]$RootCert = (Join-Path (Split-Path -Parent $PSScriptRoot) 'docs\release\railway-postgres-root-ca.pem'),
  [string]$SecretFile = (Join-Path $env:LOCALAPPDATA 'LeadFlow\preflight-password.dpapi')
)
$ErrorActionPreference = 'Stop'

if ($SavePassword) {
  New-Item -ItemType Directory -Force (Split-Path $SecretFile) | Out-Null
  $secure = Read-Host "Password for $Role" -AsSecureString
  # DPAPI (CurrentUser): unreadable by other users or on another machine.
  $secure | ConvertFrom-SecureString | Set-Content -Path $SecretFile -Encoding ascii
  Write-Host "Saved, encrypted for $env:USERNAME on $env:COMPUTERNAME: $SecretFile"
  return
}

if (-not (Test-Path $SecretFile)) { throw "No saved password. Run: .\scripts\run-preflight.ps1 -SavePassword" }

$repo = Split-Path -Parent $PSScriptRoot
$bstr = [IntPtr]::Zero
try {
  $secure = Get-Content -Path $SecretFile | ConvertTo-SecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $ssl = switch ($SslMode) {
    'disable' { 'sslmode=disable' }
    'require' {
      Write-Warning 'sslmode=require: encrypted, but the server is NOT authenticated. Use only if the pinned root certificate has changed and you have re-verified the new one.'
      'sslmode=require&uselibpqcompat=true'
    }
    default {
      if (-not (Test-Path $RootCert)) { throw "Pinned root certificate not found: $RootCert" }
      $pin = (Get-FileHash -Algorithm SHA256 -Path $RootCert).Hash
      Write-Host "TLS: verify-ca, pinned root certificate file SHA-256 $($pin.Substring(0,16))..."
      "sslmode=verify-ca&sslrootcert=$([Uri]::EscapeDataString(($RootCert -replace '\\', '/')))&uselibpqcompat=true"
    }
  }
  $env:PREFLIGHT_DATABASE_URL = "postgresql://${Role}:$([Uri]::EscapeDataString($plain))@${DbHost}:${Port}/${Database}?$ssl"
  Remove-Variable plain

  Push-Location $repo
  Write-Host "== Verifying $Role is read-only ($DbHost`:$Port/$Database)"
  node scripts/verify-preflight-role.mjs
  if ($LASTEXITCODE -ne 0) { Write-Host 'Role is NOT verified read-only. The preflight was not run.'; exit $LASTEXITCODE }

  Write-Host "`n== Preflight"
  if ($After) { node scripts/production-preflight.mjs "--after=$After" } else { node scripts/production-preflight.mjs }
  exit $LASTEXITCODE
}
finally {
  if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  Remove-Item Env:PREFLIGHT_DATABASE_URL -ErrorAction SilentlyContinue
  Pop-Location -ErrorAction SilentlyContinue
}
