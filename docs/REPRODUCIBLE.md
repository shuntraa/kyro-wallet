# Rebuilding a Kyro release

The goal: anyone can rebuild a release from its tag and check that the result is what was
published. This page says how, what is compared, and how far that has been checked so far.

## Status

| Platform | File | Result |
|---|---|---|
| Windows | `kyro-desktop.exe` (raw, and inside the NSIS and MSI installers) | Same bytes from two directories on one machine. Not yet checked between two machines |
| Windows | NSIS installer (`Kyro-windows-x64-setup.exe`) | Same bytes from two directories on one machine, with the same WebView2 bootstrapper file |
| Windows | MSI installer | Not stable (see below): compare the binary inside it |
| Linux | `kyro-desktop` (raw) | Same bytes from a build on the runner and one in the pinned container (Reproducibility run of 2026-11-16 on `main`) |
| macOS | `kyro-desktop` (universal) | Same bytes from two target folders on one machine since `-oso_prefix` (run of 2026-11-16 on `main`); before it, each slice's `LC_UUID` and the ad-hoc signature hash over it differed (64 bytes of 43.8 MB). First release with it: the version after 1.1.1 |

v1.1.0 and v1.1.1 were built with these settings. Until the Reproducibility workflow has passed on a
tag for every platform and someone has rebuilt a tag elsewhere, treat this as work in progress.

## What is compared

The app binary, not the installers:

- `SHA256SUMS` lists the published files. `SHA256SUMS-binaries` lists the unpacked app binaries.
- `windows/kyro-desktop.exe`, `linux/kyro-desktop`, `macos/kyro-desktop`: the raw build, what
  `scripts/build-binary.sh` produces. The Microsoft Store package contains this file.
- `windows/nsis/...`, `windows/msi/...`, `linux/deb/...`: the same binary as it sits inside that
  package. The Tauri bundler writes a package type over a `__TAURI_BUNDLE_TYPE_VAR_UNK` marker, three
  bytes, in the copy that goes into each package. `scripts/patch-bundle-type.mjs` applies the same
  patch, so a rebuilt binary can be compared with the one inside an installer.
- `BUILDINFO-<os>.txt` holds the tool versions of the release build.

## Rebuild and compare

Run this outside any checkout. The script clones the tag, builds, and compares with the release:

```sh
curl -fsSLO https://raw.githubusercontent.com/shuntraa/kyro-wallet/vX.Y.Z/scripts/verify-release.sh
bash verify-release.sh vX.Y.Z --installer
```

`--installer` also downloads the installers, checks them against `SHA256SUMS`, unpacks the binary
and compares it with your build. `--assets <dir>` reads the release files from a folder, for a
draft release. The script prints `MATCH` or `DIFFERENT` and exits non-zero when anything differs.
The first thing to check after a `DIFFERENT` is the tool version diff it prints before building.

No signing key is involved: `tauri build --no-bundle` compiles the same binary as the release, and
update signatures are separate `.sig` files that change neither the binary nor the installer.

### Windows

Git Bash, with Rust through rustup (`rust-toolchain.toml` selects the version), Node, the pnpm
version of `package.json` and 7-Zip for `--installer`. The binary depends on the MSVC tools, so
install the versions of `BUILDINFO-windows.txt`: Visual Studio 2022 Build Tools with that MSVC
toolset and Windows SDK. The release is built on GitHub's `windows-2022` image.

### Linux

The script builds in the pinned container of `scripts/repro-linux.Dockerfile` (needs Docker): Ubuntu
22.04 by digest, packages from a dated Ubuntu snapshot, exact Node and pnpm. `--no-container` builds
on your machine instead, which then needs the versions of `BUILDINFO-linux.txt`.

The release itself is built on the `ubuntu-22.04` runner, not in this container. Whether the two
match is what the Reproducibility workflow checks. If they do not, the release should move into
the container. The binary inside the AppImage is not compared: the AppImage tools may rewrite it.

### macOS

Needs the Xcode version of `BUILDINFO-macos.txt`. The release is a universal binary built on
`macos-15-intel`.

### The NSIS installer, byte for byte

`--installer` compares the binary inside. The whole installer also matches if your build embeds the
same WebView2 bootstrapper: Tauri downloads Microsoft's current file when packaging and keeps it in
`%LOCALAPPDATA%\tauri`. Take it from the published installer (7-Zip:
`$TEMP\MicrosoftEdgeWebview2Setup.exe`), put it there, then:

```sh
pnpm --dir apps/desktop tauri bundle --bundles nsis --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

## What makes a build stable

`scripts/repro-env.sh` is the single source of these settings, for the release, the CI check and
the verify script.

| Source of difference | Fix |
|---|---|
| Absolute paths in Rust code: source files, registry crates, `OUT_DIR` (panic locations) | `--remap-path-prefix` for the checkout, `CARGO_HOME`, the target folder and rust-src. This also keeps user names and local folders out of the binary. Passed through `CARGO_ENCODED_RUSTFLAGS` because a path can contain spaces |
| Absolute paths in C code: `__FILE__` in `assert()` (libusb) | MSVC: `/experimental:deterministic /pathmap:`. GCC and clang: `-ffile-prefix-map=`. `CC_SHELL_ESCAPED_FLAGS=1` lets the `cc` crate keep paths with spaces |
| PE header and debug directory timestamps, PDB id | `/Brepro`: a hash of the content instead of the link time |
| Tailwind's automatic scan reads everything in the folder, so the CSS, and every chunk hash after it, depended on what else was on disk | Explicit `source()` and `@source` in `apps/desktop/src/styles.css` |
| Source file dates inside the NSIS installer | `SetDateSave off` in `installer/installer.nsi`. Installed files carry the install date |
| Clock-based dates in tools | `SOURCE_DATE_EPOCH` = the commit's date, `TZ=UTC`, `LC_ALL=C` |
| Archive dates on macOS | `ZERO_AR_DATE=1` |
| macOS `LC_UUID`: Apple's linker hashes the object paths it records (N_OSO), which name the target folder; `strip` then drops the paths but keeps the UUID | `-Wl,-oso_prefix,<target folder>/`: the paths are recorded relative to it |
| Tool versions | `rust-toolchain.toml`, `pnpm-lock.yaml`, `Cargo.lock`, exact Node and pnpm, `BUILDINFO-<os>.txt` |

The release profile (`codegen-units = 1`, fat LTO, `opt-level = "s"`, `panic = "abort"`, `strip`)
already suited this and is unchanged: no optimisation or security setting was lowered. `/Brepro`
only replaces timestamps. Build date and git information are not embedded anywhere in the app.

## What stays different

- **MSI installer.** WiX generates a random `ProductCode` and `PackageCode` on every build, and
  `app.cab` stores a file date. Everything else, 44 of 47 streams, is identical. Compare the binary.
- **WebView2 bootstrapper.** Microsoft's file changes over time, so an installer packaged later embeds
  a newer one. The app binary is not affected.
- **`.sig` files and `latest.json`.** They come from the private update key and the release time.
- **`.dmg`, `.app.tar.gz`, AppImage, `.deb`.** Not tested. Compare the binary.

## CI

`.github/workflows/reproducibility.yml` runs on each tag, and by hand from the Actions tab once it
is on the default branch. Per platform it builds twice from two directories and fails when the
binaries differ, attaching both to the run. Linux does the second build in the pinned container.
Windows also compares the two NSIS installers, as a warning. It uses no secret and never blocks a
release.

When bumping the Rust, Node or pnpm version, or the image digest and snapshot date in
`scripts/repro-linux.Dockerfile`, change them in their own commit.
