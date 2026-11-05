#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Builds the raw Kyro app binary reproducibly, from the repository root, and prints its path on the
# last line. Same compile as the release workflow, without packaging: no signing key is needed.
# See docs/REPRODUCIBLE.md.
set -euo pipefail

eval "$(scripts/repro-env.sh --export)"

target="${CARGO_TARGET_DIR:-$(pwd)/target}"
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    args=()
    binary="$target/release/kyro-desktop.exe" ;;
  Darwin)
    args=(--target universal-apple-darwin)
    binary="$target/universal-apple-darwin/release/kyro-desktop" ;;
  *)
    args=()
    binary="$target/release/kyro-desktop" ;;
esac

pnpm install --frozen-lockfile >&2
pnpm --dir apps/desktop tauri build --no-bundle ${args[@]+"${args[@]}"} >&2

test -f "$binary"
printf '%s\n' "$binary"
