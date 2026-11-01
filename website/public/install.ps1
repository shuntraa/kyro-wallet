# SPDX-License-Identifier: GPL-3.0-or-later
# Kyro Wallet installer for Windows (Windows PowerShell 5.1 and PowerShell 7).
#
#   irm https://kyrowallet.com/install.ps1 | iex
#
# What it does, and nothing else:
#   1. downloads Kyro-windows-x64-setup.exe and SHA256SUMS from the latest GitHub release,
#   2. checks the installer's SHA-256 against SHA256SUMS and stops if it does not match,
#   3. starts the installer (normal window: you choose the options and click Install),
#   4. deletes the downloaded files.
# No telemetry, no administrator rights requested by this script. Source: website/src/install.ps1
# in https://github.com/shuntraa/kyro-wallet

# Everything runs inside a script block so that settings and variables do not leak into your
# PowerShell session, and so that an error never closes the window (no 'exit').
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'   # the progress bar makes Invoke-WebRequest very slow on 5.1

  $Base = 'https://github.com/shuntraa/kyro-wallet/releases/latest/download'
  $File = 'Kyro-windows-x64-setup.exe'

  function Say([string]$Text) { Write-Host "kyro: $Text" }

  if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'Kyro needs 64-bit Windows 10 or 11.'
  }

  # GitHub only accepts TLS 1.2 or newer; Windows PowerShell 5.1 may default to older versions.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $Dir = Join-Path ([IO.Path]::GetTempPath()) ('kyro-install-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $Dir | Out-Null
  $Exe = Join-Path $Dir $File
  $Sums = Join-Path $Dir 'SHA256SUMS'

  try {
    Say "downloading $File from GitHub Releases..."
    Invoke-WebRequest -UseBasicParsing -Uri "$Base/$File" -OutFile $Exe
    Invoke-WebRequest -UseBasicParsing -Uri "$Base/SHA256SUMS" -OutFile $Sums

    # SHA256SUMS lines look like: <64 hex characters><two spaces><file name>
    $Expected = $null
    foreach ($Line in Get-Content -LiteralPath $Sums) {
      $Parts = $Line.Trim() -split '\s+'
      if ($Parts.Count -eq 2 -and $Parts[1].TrimStart('*') -eq $File) { $Expected = $Parts[0].ToLowerInvariant() }
    }
    if (-not $Expected) { throw "SHA256SUMS has no line for $File. Nothing was installed." }

    $Actual = (Get-FileHash -LiteralPath $Exe -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Actual -ne $Expected) {
      throw ("Checksum mismatch for $File. Nothing was installed.`n" +
        "  expected $Expected`n  got      $Actual`n" +
        'The download is corrupted or was modified. Try again later, or report it at https://github.com/shuntraa/kyro-wallet/issues')
    }
    Say "SHA-256 verified: $Actual"

    Say 'starting the installer...'
    $Proc = Start-Process -FilePath $Exe -Wait -PassThru
    if ($Proc.ExitCode -eq 0) {
      Say 'done. Open Kyro from the Start menu.'
    } else {
      Say "the installer closed with code $($Proc.ExitCode) (cancelled or failed)."
    }
  } finally {
    Remove-Item -LiteralPath $Dir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
