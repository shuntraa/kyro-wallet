#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Prints the tool versions that decide the bytes of the app binary (docs/REPRODUCIBLE.md). The
# release publishes this output as BUILDINFO-<os>.txt; a rebuild needs the same tools to match.
# Versions only: no path, user or machine name.
set -euo pipefail

echo "rustc: $(rustc -V)"
echo "node: $(node -v)"
echo "pnpm: $(pnpm -v)"

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    vswhere="/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe"
    vs="$(cygpath -u "$("$vswhere" -latest -products '*' -property installationPath | tr -d '\r')")"
    echo "visual-studio: $("$vswhere" -latest -products '*' -property installationVersion | tr -d '\r')"
    echo "msvc-tools: $(tr -d '\r' < "$vs/VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt")"
    echo "windows-sdk: $(ls "/c/Program Files (x86)/Windows Kits/10/Lib" | grep '^10\.' | sort -V | tail -n 1)"
    ;;
  Darwin)
    echo "xcode: $(xcodebuild -version | tr '\n' ' ')"
    echo "macos-sdk: $(xcrun --show-sdk-version)"
    ;;
  *)
    for package in gcc binutils libc6-dev; do
      echo "$package: $(dpkg-query -W -f='${Version}' "$package")"
    done
    ;;
esac
