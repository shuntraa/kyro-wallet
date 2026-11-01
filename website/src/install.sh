#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Kyro Wallet installer for macOS and Linux (x86_64).
#
#   curl -fsSL https://kyrowallet.com/install.sh | sh
#
# What it does, and nothing else:
#   macOS: downloads Kyro-macos.app.tar.gz and SHA256SUMS from the latest GitHub release, checks
#          the SHA-256 and puts Kyro.app in /Applications (or ~/Applications).
#   Linux: downloads Kyro-linux-x86_64.AppImage and SHA256SUMS, checks the SHA-256, installs it
#          as ~/.local/bin/kyro and adds a menu entry.
# No telemetry, no sudo. Source: website/src/install.sh in https://github.com/shuntraa/kyro-wallet

set -eu

BASE="https://github.com/shuntraa/kyro-wallet/releases/latest/download"
ICON_URL="https://kyrowallet.com/img/kyro-256.png"

say() { printf 'kyro: %s\n' "$*"; }
die() { printf 'kyro: error: %s\n' "$*" >&2; exit 1; }

fetch() { # fetch <url> <output file>
  curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1" || die "could not download $1"
}

# verify <dir> <file>: compare the file's SHA-256 with its line in SHA256SUMS.
verify() {
  expected=$(awk -v f="$2" '$2 == f || $2 == "*" f { print $1 }' "$1/SHA256SUMS")
  [ -n "$expected" ] || die "SHA256SUMS has no line for $2. Nothing was installed."
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$1/$2" | awk '{ print $1 }')
  else
    actual=$(shasum -a 256 "$1/$2" | awk '{ print $1 }')
  fi
  if [ "$actual" != "$expected" ]; then
    die "checksum mismatch for $2 (expected $expected, got $actual). The download is corrupted or was modified. Nothing was installed."
  fi
  say "SHA-256 verified: $actual"
}

# ask <question>: yes/no on the terminal. The script itself arrives on stdin, so read /dev/tty.
ask() {
  [ -r /dev/tty ] || return 1
  printf 'kyro: %s [y/N] ' "$1" >/dev/tty
  read -r answer </dev/tty || return 1
  case "$answer" in [yY] | [yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

install_macos() {
  file="Kyro-macos.app.tar.gz"
  say "downloading $file from GitHub Releases..."
  fetch "$BASE/$file" "$tmp/$file"
  fetch "$BASE/SHA256SUMS" "$tmp/SHA256SUMS"
  verify "$tmp" "$file"
  tar -xzf "$tmp/$file" -C "$tmp"
  [ -d "$tmp/Kyro.app" ] || die "Kyro.app not found in $file."

  dest="/Applications"
  if [ ! -w "$dest" ]; then dest="$HOME/Applications"; mkdir -p "$dest"; fi
  if [ -e "$dest/Kyro.app" ]; then
    ask "$dest/Kyro.app already exists. Replace it?" || die "kept the existing $dest/Kyro.app. Nothing was changed."
    rm -rf "$dest/Kyro.app"
  fi
  mv "$tmp/Kyro.app" "$dest/Kyro.app"
  say "installed $dest/Kyro.app"
  say "open it from Launchpad, or run: open \"$dest/Kyro.app\""
}

install_linux() {
  file="Kyro-linux-x86_64.AppImage"
  bin="$HOME/.local/bin"
  apps="$HOME/.local/share/applications"
  icons="$HOME/.local/share/icons/hicolor/256x256/apps"
  say "downloading $file from GitHub Releases..."
  fetch "$BASE/$file" "$tmp/$file"
  fetch "$BASE/SHA256SUMS" "$tmp/SHA256SUMS"
  verify "$tmp" "$file"

  mkdir -p "$bin" "$apps" "$icons"
  mv "$tmp/$file" "$bin/kyro"
  chmod +x "$bin/kyro"
  # The icon is optional: the menu entry still works without it.
  curl -fsSL --proto '=https' -o "$icons/kyro.png" "$ICON_URL" 2>/dev/null || rm -f "$icons/kyro.png"
  cat >"$apps/kyro.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Kyro Wallet
Comment=Non-custodial crypto wallet
Exec=$bin/kyro
Icon=kyro
Terminal=false
Categories=Finance;
EOF
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$apps" >/dev/null 2>&1 || true
  say "installed $bin/kyro and a menu entry (Kyro Wallet)"

  # AppImages need FUSE 2 (libfuse.so.2), missing by default on recent Ubuntu releases.
  if ! { ldconfig -p 2>/dev/null || /sbin/ldconfig -p 2>/dev/null; } | grep -q 'libfuse\.so\.2'; then
    say "FUSE 2 seems to be missing. Install it first: sudo apt install libfuse2t64 (Ubuntu 24.04+) or libfuse2 (older)"
  fi
  case ":$PATH:" in *":$bin:"*) say "start it from your app menu or run: kyro" ;; *) say "start it from your app menu or run: $bin/kyro" ;; esac
}

main() {
  command -v curl >/dev/null 2>&1 || die "curl is required."
  os=$(uname -s)
  arch=$(uname -m)
  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t kyro)
  trap 'rm -rf "$tmp"' EXIT
  trap 'exit 1' INT TERM

  case "$os" in
    Darwin) install_macos ;; # one universal app for Apple Silicon and Intel
    Linux)
      [ "$arch" = "x86_64" ] || die "Kyro for Linux is built for x86_64 only (this machine is $arch). See https://kyrowallet.com/download/"
      install_linux ;;
    *) die "this script supports macOS and Linux. For Windows, run in PowerShell: irm https://kyrowallet.com/install.ps1 | iex" ;;
  esac
}

# Called last, so a partially downloaded script never runs.
main "$@"
