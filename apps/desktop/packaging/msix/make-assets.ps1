# SPDX-License-Identifier: GPL-3.0-or-later
# Regenerates the MSIX logos in Assets/ from the app icon (src-tauri/icons/icon.png, 512x512).
# Run it only when the icon changes; the generated PNGs are committed. Windows PowerShell 5.1+.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$src = Join-Path $PSScriptRoot '..\..\src-tauri\icons\icon.png'
$out = Join-Path $PSScriptRoot 'Assets'
New-Item -ItemType Directory -Force $out | Out-Null
$icon = [System.Drawing.Image]::FromFile((Resolve-Path $src))

# name, width, height, icon size inside the canvas (centered, transparent background)
function Render([string]$name, [int]$w, [int]$h, [int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($icon, [int](($w - $size) / 2), [int](($h - $size) / 2), $size, $size)
  $g.Dispose()
  $bmp.Save((Join-Path $out $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

foreach ($s in @(@{ n = 'scale-100'; f = 1 }, @{ n = 'scale-200'; f = 2 })) {
  $f = $s.f
  Render "StoreLogo.$($s.n).png" (50 * $f) (50 * $f) (50 * $f)
  Render "Square44x44Logo.$($s.n).png" (44 * $f) (44 * $f) (44 * $f)
  Render "Square150x150Logo.$($s.n).png" (150 * $f) (150 * $f) (100 * $f)
  Render "Wide310x150Logo.$($s.n).png" (310 * $f) (150 * $f) (100 * $f)
  Render "SmallTile.$($s.n).png" (71 * $f) (71 * $f) (48 * $f)
  Render "LargeTile.$($s.n).png" (310 * $f) (310 * $f) (200 * $f)
}
# Taskbar / Start list / title bar icons: exact sizes, plated and unplated.
foreach ($t in 16, 24, 32, 48, 256) {
  Render "Square44x44Logo.targetsize-$t.png" $t $t $t
  Render "Square44x44Logo.targetsize-${t}_altform-unplated.png" $t $t $t
  Render "Square44x44Logo.targetsize-${t}_altform-lightunplated.png" $t $t $t
}
$icon.Dispose()
Write-Host "MSIX assets written to $out"
