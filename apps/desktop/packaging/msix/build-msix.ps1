# SPDX-License-Identifier: GPL-3.0-or-later
# Builds the Microsoft Store package Kyro-windows-x64.msix from a release kyro-desktop.exe.
#
#   pwsh apps/desktop/packaging/msix/build-msix.ps1 -Exe target/release/kyro-desktop.exe
#
# The package is UNSIGNED: Partner Center signs it for the Store. To install it locally, sign a
# copy with a test certificate whose subject equals the manifest Publisher (docs/RELEASING.md).
# Needs the Windows 10/11 SDK (makeappx.exe, makepri.exe). Tauri bundles no extra resource for
# Kyro (no `bundle.resources`, WebView2 loader linked statically): the exe is the whole app, and
# the MSIX relies on the system WebView2 Evergreen runtime.
param(
  [Parameter(Mandatory)] [string] $Exe,
  [string] $Out = 'Kyro-windows-x64.msix',
  # x.y.z from tauri.conf.json; the package version is x.y.z.0 (the Store requires revision 0).
  [string] $Version
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$here = $PSScriptRoot
if (-not $Version) {
  $conf = Get-Content (Join-Path $here '..\..\src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
  $Version = $conf.version
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "version must be x.y.z (no pre-release for the Store): $Version" }
$pkgVersion = "$Version.0"

$exePath = (Resolve-Path $Exe).Path
$sdk = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\10.*\x64\makeappx.exe' -ErrorAction SilentlyContinue |
  Sort-Object { [version]$_.Directory.Parent.Name } | Select-Object -Last 1
if (-not $sdk) { throw 'Windows SDK not found (makeappx.exe)' }
$makeappx = $sdk.FullName
$makepri = Join-Path $sdk.DirectoryName 'makepri.exe'

$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("kyro-msix-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $stage | Out-Null
try {
  Copy-Item $exePath (Join-Path $stage 'kyro-desktop.exe')
  Copy-Item (Join-Path $here 'Assets') (Join-Path $stage 'Assets') -Recurse
  $manifest = (Get-Content (Join-Path $here 'AppxManifest.xml') -Raw).Replace('__VERSION__', $pkgVersion)
  [System.IO.File]::WriteAllText((Join-Path $stage 'AppxManifest.xml'), $manifest, (New-Object System.Text.UTF8Encoding($false)))

  # resources.pri: maps Assets\X.png to its scale / target-size variants.
  $cfg = Join-Path ([System.IO.Path]::GetTempPath()) ("kyro-priconfig-" + [guid]::NewGuid().ToString('N') + '.xml')
  & $makepri createconfig /cf $cfg /dq en-US /pv 10.0.0 /o | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "makepri createconfig failed ($LASTEXITCODE)" }
  & $makepri new /pr $stage /cf $cfg /mn (Join-Path $stage 'AppxManifest.xml') /of (Join-Path $stage 'resources.pri') /o | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "makepri new failed ($LASTEXITCODE)" }
  Remove-Item $cfg

  $outPath = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path (Get-Location).Path $Out }
  & $makeappx pack /d $stage /p $outPath /o
  if ($LASTEXITCODE -ne 0) { throw "makeappx pack failed ($LASTEXITCODE)" }
  Write-Host "built $outPath (version $pkgVersion)"
} finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
