# Signs Windows files (.exe, .dll, .msi, ...) with Azure Artifact Signing.
# release-windows.yml passes its path to build commands as APPS_SIGN_SCRIPT:
#
#   pwsh -File $env:APPS_SIGN_SCRIPT build\App.exe build\Helper.dll
#
# Uses Microsoft's ArtifactSigning PowerShell module (Invoke-ArtifactSigning,
# formerly TrustedSigning), installing it for the current user if it's missing.
# The module fetches signtool and the Artifact Signing client itself, and
# needs the .NET 8 runtime. Signs with SHA-256 and Microsoft's timestamp
# server, so signatures stay valid after the 3-day certificate expires.
#
# Env: AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT, AZURE_SIGNING_PROFILE,
# and AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET of an Entra app
# registration with the Artifact Signing Certificate Profile Signer role.
[CmdletBinding()]
param(
  [Parameter(Mandatory, ValueFromRemainingArguments)]
  [string[]]$Path
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$missing = @(
  'AZURE_SIGNING_ENDPOINT', 'AZURE_SIGNING_ACCOUNT', 'AZURE_SIGNING_PROFILE',
  'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'
) | Where-Object { -not [Environment]::GetEnvironmentVariable($_) }
if ($missing) {
  throw "Artifact Signing needs $($missing -join ', '). In CI they come from the production environment; run ``apps init``."
}

# The module takes one comma-separated list of absolute paths.
$files = foreach ($item in $Path) {
  $full = (Resolve-Path -LiteralPath $item).ProviderPath
  if ($full.Contains(',')) { throw "can't sign ${full}: Artifact Signing takes a comma-separated list, so paths can't contain commas" }
  $full
}

if (-not (Get-Module -ListAvailable -Name ArtifactSigning)) {
  Write-Host '==> installing the ArtifactSigning PowerShell module'
  Install-Module -Name ArtifactSigning -Scope CurrentUser -Repository PSGallery -Force
}
Import-Module ArtifactSigning

$params = @{
  Endpoint               = $env:AZURE_SIGNING_ENDPOINT
  CodeSigningAccountName = $env:AZURE_SIGNING_ACCOUNT
  CertificateProfileName = $env:AZURE_SIGNING_PROFILE
  Files                  = $files -join ','
  FileDigest             = 'SHA256'
  TimestampRfc3161       = 'http://timestamp.acs.microsoft.com'
  TimestampDigest        = 'SHA256'
  # Only the AZURE_* client secret, so a CI machine never waits on a browser
  # login or probes for a managed identity.
  ExcludeWorkloadIdentityCredential   = $true
  ExcludeManagedIdentityCredential    = $true
  ExcludeSharedTokenCacheCredential   = $true
  ExcludeVisualStudioCredential       = $true
  ExcludeVisualStudioCodeCredential   = $true
  ExcludeAzureCliCredential           = $true
  ExcludeAzurePowerShellCredential    = $true
  ExcludeAzureDeveloperCliCredential  = $true
  ExcludeInteractiveBrowserCredential = $true
}

# The signing and timestamp services fail now and then, so try again after a pause.
$attempts = 3
for ($n = 1; ; $n++) {
  Write-Host "==> signing $($files -join ', ')"
  try {
    Invoke-ArtifactSigning @params | Out-Host
    break
  } catch {
    if ($n -ge $attempts) { throw "signing failed after $attempts attempts: $_" }
    Write-Warning "attempt $n of $attempts failed, trying again in $($n * 20)s: $_"
    Start-Sleep -Seconds ($n * 20)
  }
}

foreach ($file in $files | Where-Object { $_ -match '\.(exe|dll|msi)$' }) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file
  if ($signature.Status -ne 'Valid') { throw "$file isn't validly signed after signing: $($signature.Status) $($signature.StatusMessage)" }
}
