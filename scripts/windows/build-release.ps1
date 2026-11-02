# Builds, signs and verifies a Windows release as apps.json's builds.windows
# describes it. release-windows.yml runs it from the app repo (the folder
# holding apps.json):
#
#   $env:VERSION = '1.2.3'; $env:BUILD = '100200300'
#   pwsh -File scripts/windows/build-release.ps1 [apps.json]
#
# Writes installer=, blockmap= (paths of what to publish),
# minimum_system_version= and icon= (a PNG for the download page, empty if
# there's none) to $GITHUB_OUTPUT, or to stdout when that isn't set. Build and
# signing output goes to the host only, never to those lines.
#
# Env: VERSION, BUILD, and for signing AZURE_SIGNING_* and AZURE_TENANT_ID,
# AZURE_CLIENT_ID, AZURE_CLIENT_SECRET (see sign.ps1). Needs node.
[CmdletBinding()]
param(
  [string]$Config = 'apps.json'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Note([string]$message) { Write-Host "==> $message" }

if ($env:VERSION -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { throw 'VERSION must look like 1.2.3' }
if ($env:BUILD -notmatch '^[0-9]+$') { throw 'BUILD must be a whole number' }
$version = $env:VERSION
if (-not (Test-Path -LiteralPath $Config)) { throw "$Config not found" }

# Same checks and keys as the shell scripts get from read-config.sh.
$lines = & node (Join-Path $PSScriptRoot '..\common\read-config.mjs') $Config windows
if ($LASTEXITCODE -ne 0) { throw "couldn't read $Config" }
$settings = @{}
foreach ($line in $lines) {
  $key, $value = $line -split '=', 2
  $settings[$key] = $value
}
function Resolve-Artifact([string]$template) { $template.Replace('{version}', $version) }

$kind = $settings.kind
$installer = Resolve-Artifact $settings.installer
$blockmap = if ($settings.blockmap) { Resolve-Artifact $settings.blockmap } else { '' }

# Stale files from an earlier build must never be published as this one.
foreach ($file in @($installer, $blockmap) | Where-Object { $_ }) {
  Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
}

$env:APPS_SIGN_SCRIPT = Join-Path $PSScriptRoot 'sign.ps1'
Note "building: $($settings.command)"
& pwsh -NoProfile -NonInteractive -Command $settings.command | Out-Host
if ($LASTEXITCODE -ne 0) { throw "the build command failed (exit $LASTEXITCODE)" }
foreach ($file in @($installer, $blockmap) | Where-Object { $_ }) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "the build command didn't produce $file" }
}

$signature = Get-AuthenticodeSignature -LiteralPath $installer
if ($signature.Status -ne 'Valid') {
  if ($kind -eq 'electron') {
    # Signing here would change the installer after electron-builder wrote its
    # blockmap, and the app inside would still be unsigned.
    throw "$installer isn't signed ($($signature.Status)). Pass the config with --config electron-builder.config.js (electron-builder 26 doesn't load it on its own), and set win.azureSignOptions in it from the AZURE_SIGNING_* variables."
  }
  Note "signing $installer"
  & pwsh -NoProfile -NonInteractive -File $env:APPS_SIGN_SCRIPT $installer | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "signing $installer failed" }
  $signature = Get-AuthenticodeSignature -LiteralPath $installer
}

if ($signature.Status -ne 'Valid') { throw "$installer isn't validly signed: $($signature.Status) $($signature.StatusMessage)" }
if (-not $signature.TimeStamperCertificate) { throw "$installer is signed without a timestamp, so its signature would expire with the certificate" }
Note "$installer is signed by $($signature.SignerCertificate.Subject)"

$productVersion = (Get-Item -LiteralPath $installer).VersionInfo.ProductVersion
if ($productVersion) {
  $productVersion = $productVersion.Trim()
  if ($productVersion -notmatch "^$([regex]::Escape($version))(?![0-9])") {
    throw "$installer says version '$productVersion', expected $version; the build command must use `$env:VERSION"
  }
}

# The download page shows the icon, but a release never fails over it.
$icon = ''
if ($settings.icon) {
  if (Test-Path -LiteralPath $settings.icon -PathType Leaf) {
    $icon = $settings.icon
  } else {
    Write-Warning "builds.windows.icon $($settings.icon) doesn't exist; publishing without an icon"
  }
}

$outputs = @(
  "installer=$installer"
  "blockmap=$blockmap"
  "minimum_system_version=$($settings.minimum_system_version)"
  "icon=$icon"
)
$outputs | ForEach-Object { Note $_ }
if ($env:GITHUB_OUTPUT) {
  $outputs | Add-Content -LiteralPath $env:GITHUB_OUTPUT -Encoding utf8
} else {
  $outputs
}
