#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Prints, as KEY=VALUE lines, the environment of a reproducible Kyro build (docs/REPRODUCIBLE.md).
# The release workflow, the reproducibility workflow and scripts/verify-release.sh all use it, so
# the flags live in one place:
#
#   scripts/repro-env.sh >> "$GITHUB_ENV"            # GitHub Actions
#   eval "$(scripts/repro-env.sh --export)"          # a shell
#
# Run it from the repository root, in Git Bash on Windows. Respects CARGO_TARGET_DIR and CARGO_HOME.
# Nothing here lowers optimisation or removes a security setting: see docs/REPRODUCIBLE.md.
set -euo pipefail

export_mode=0
[ "${1:-}" = "--export" ] && export_mode=1

root="$(pwd)"
target="${CARGO_TARGET_DIR:-$root/target}"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
sysroot="$(rustc --print sysroot)"
commit_hash="$(rustc -vV | sed -n 's/^commit-hash: //p')"

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) os=windows ;;
  Darwin) os=macos ;;
  *) os=linux ;;
esac

# rustc and cl.exe see native paths: C:\x, not /c/x.
native() {
  if [ "$os" = windows ]; then cygpath -w "$1"; else printf '%s' "$1"; fi
}

# Build date: the commit's, never the clock's.
epoch="${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct)}"

# Later rules win in rustc, so the most specific path comes last.
flags=(
  "--remap-path-prefix=$(native "$root")=/kyro"
  "--remap-path-prefix=$(native "$cargo_home")=/cargo"
  "--remap-path-prefix=$(native "$target")=/target"
  # Only matters when the rust-src component is installed: rustc then points back to the local copy.
  "--remap-path-prefix=$(native "$sysroot/lib/rustlib/src/rust")=/rustc/$commit_hash"
)
if [ "$os" = windows ]; then
  # PE header timestamp and import tables: a hash of the content instead of the link time.
  flags+=("-Clink-arg=/Brepro")
fi
if [ "$os" = macos ]; then
  # Apple's linker hashes the object paths it records (N_OSO) into the binary's LC_UUID, then the
  # release strip removes those paths but keeps the UUID: two builds in different target dirs
  # differed only there (and in the ad-hoc signature hash that covers it). Record them relative to
  # the target dir instead.
  flags+=("-Clink-arg=-Wl,-oso_prefix,$target/")
fi

# CARGO_ENCODED_RUSTFLAGS, not RUSTFLAGS: a path may contain spaces. Separator: 0x1f.
encoded="$(IFS=$'\x1f'; printf '%s' "${flags[*]}")"

emit() {
  if [ "$export_mode" = 1 ]; then
    printf 'export %s=%q\n' "$1" "$2"
  else
    printf '%s=%s\n' "$1" "$2"
  fi
}

emit SOURCE_DATE_EPOCH "$epoch"
emit CARGO_INCREMENTAL 0
emit CARGO_ENCODED_RUSTFLAGS "$encoded"
emit TZ UTC
emit LC_ALL C

# C code of the vendored crates (SQLite, libusb, ring, zstd...): __FILE__, which assert() embeds, and
# debug paths. Parsed by the cc crate as shell words, so that a path may contain spaces.
if [ "$os" = windows ]; then
  c_flags="/experimental:deterministic"
  for map in "$(native "$target")=/target" "$(native "$cargo_home")=/cargo" "$(native "$root")=/kyro"; do
    c_flags="$c_flags '/pathmap:$map'"
  done
else
  c_flags="'-ffile-prefix-map=$target=/target' '-ffile-prefix-map=$cargo_home=/cargo' '-ffile-prefix-map=$root=/kyro'"
fi
emit CC_SHELL_ESCAPED_FLAGS 1
emit CFLAGS "$c_flags"
emit CXXFLAGS "$c_flags"

if [ "$os" = macos ]; then
  # ld64 and ar store modification times unless told otherwise.
  emit ZERO_AR_DATE 1
fi
