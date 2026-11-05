#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Rebuilds a published Kyro release from its tag and compares the result with the hashes published
# in that release. See docs/REPRODUCIBLE.md for what is compared and what is not.
#
#   scripts/verify-release.sh v1.2.3 [--dir <work dir>] [--assets <dir>] [--no-container] [--installer]
#
# --dir           where to clone and build (default: ./kyro-verify-<tag>)
# --assets        take the release files from this folder instead of downloading them (a draft
#                 release has no public URL)
# --no-container  Linux: build on this machine instead of the pinned container
# --installer     also download the published installer, check it against SHA256SUMS, extract the
#                 app binary and compare it with this build (Windows: needs 7-Zip)
set -euo pipefail

repo="https://github.com/shuntraa/kyro-wallet"
tag=""
work=""
assets=""
container=1
installer=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) work="$2"; shift 2 ;;
    --assets) assets="$(cd "$2" && pwd)"; shift 2 ;;
    --no-container) container=0; shift ;;
    --installer) installer=1; shift ;;
    v*) tag="$1"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$tag" ] || { echo "usage: verify-release.sh <tag> [--dir <dir>] [--assets <dir>] [--no-container] [--installer]" >&2; exit 2; }
work="${work:-$(pwd)/kyro-verify-$tag}"

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) os=windows; name=kyro-desktop.exe ;;
  Darwin) os=macos; name=kyro-desktop ;;
  *) os=linux; name=kyro-desktop ;;
esac

sha() {
  if command -v sha256sum > /dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

mkdir -p "$work"
src="$work/kyro"
[ -d "$src/.git" ] || git clone --depth 1 --branch "$tag" "$repo.git" "$src"
echo "source: $tag = $(git -C "$src" rev-parse HEAD)"

get() { # get <asset>: from --assets, else from the release
  if [ -n "$assets" ]; then
    cp "$assets/$1" "$work/$1"
  else
    curl -fsSL "$repo/releases/download/$tag/$1" -o "$work/$1"
  fi
}
get SHA256SUMS
get SHA256SUMS-binaries
get "BUILDINFO-$os.txt"

cd "$src"
if [ "$os" = linux ] && [ "$container" = 1 ]; then
  docker build -t kyro-repro -f scripts/repro-linux.Dockerfile scripts
  # The epoch comes from here: inside the container, git refuses a clone owned by another user.
  docker run --rm -v "$src:/src" -w /src -e SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)" \
    kyro-repro bash scripts/build-binary.sh
  binary="$src/target/release/$name"
else
  scripts/build-info.sh > "$work/BUILDINFO-local.txt"
  if ! diff -u "$work/BUILDINFO-$os.txt" "$work/BUILDINFO-local.txt"; then
    echo "note: the tools above differ from the release build's. A different hash may come from that." >&2
  fi
  binary="$(scripts/build-binary.sh | tail -n 1)"
fi

mine="$(sha "$binary")"
expected="$(awk -v f="$os/$name" '$2 == f { print $1 }' "$work/SHA256SUMS-binaries")"
[ -n "$expected" ] || { echo "no entry for $os/$name in SHA256SUMS-binaries" >&2; exit 1; }
echo "published: $expected  $os/$name"
echo "rebuilt:   $mine  $binary"
if [ "$mine" != "$expected" ]; then
  echo "DIFFERENT: this build does not match the published hash." >&2
  exit 1
fi
echo "MATCH: the rebuilt app binary has the published hash."

[ "$installer" = 1 ] || exit 0

# The binary inside a published installer, against this build plus the bundler's 3-byte marker.
check_packaged() { # check_packaged <marker> <extracted binary>
  node scripts/patch-bundle-type.mjs "$binary" "$1" "$work/expected-$1"
  if [ "$(sha "$2")" = "$(sha "$work/expected-$1")" ]; then
    echo "MATCH: the binary inside the installer ($1) is this build."
  else
    echo "DIFFERENT: the binary inside the installer ($1) is not this build." >&2
    exit 1
  fi
}
fetch() { # fetch <asset>: get it and check it against SHA256SUMS
  get "$1"
  [ "$(sha "$work/$1")" = "$(awk -v f="$1" '$2 == f { print $1 }' "$work/SHA256SUMS")" ] ||
    { echo "$1 does not match SHA256SUMS" >&2; exit 1; }
}

case "$os" in
  windows)
    sevenzip="$(command -v 7z || echo '/c/Program Files/7-Zip/7z.exe')"
    fetch Kyro-windows-x64-setup.exe
    "$sevenzip" x -y -o"$(cygpath -w "$work/nsis")" "$(cygpath -w "$work/Kyro-windows-x64-setup.exe")" > /dev/null
    check_packaged NSS "$work/nsis/kyro-desktop.exe"
    fetch Kyro-windows-x64.msi
    "$sevenzip" x -y -o"$(cygpath -w "$work/msi")" "$(cygpath -w "$work/Kyro-windows-x64.msi")" > /dev/null
    "$sevenzip" x -y -o"$(cygpath -w "$work/cab")" "$(cygpath -w "$work/msi/app.cab")" > /dev/null
    # The cab names its files after WiX ids: the app is its largest file.
    check_packaged MSI "$(find "$work/cab" -type f -printf '%s %p\n' | sort -n | tail -n 1 | cut -d' ' -f2-)" ;;
  linux)
    fetch Kyro-linux-amd64.deb
    mkdir -p "$work/deb"
    (cd "$work/deb" && ar x ../Kyro-linux-amd64.deb && tar -xf data.tar.*)
    check_packaged DEB "$work/deb/usr/bin/kyro-desktop" ;;
  macos)
    echo "macOS: the update package holds the binary unpatched; compare by hand (docs/REPRODUCIBLE.md)." ;;
esac
