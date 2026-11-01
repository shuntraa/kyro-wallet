# Releasing a Kyro version

Installed wallets update themselves from the GitHub releases of
`shuntraa/kyro-wallet` (see SECURITY.md "Automatic updates"). They only install
a package **signed by Kyro's update key** and newer than the running version.

## 1. The signing key (one time only)

Generated with the Tauri CLI, without a password:

```sh
cd apps/desktop
pnpm tauri signer generate --ci -w "C:\Users\<you>\.tauri\kyro-updater.key"
```

- `kyro-updater.key`: **private** key. Never in the repository, never displayed, kept offline
  (backup copy). Losing it = installed wallets can no longer receive updates
  (a version carrying a new public key would have to be reinstalled by hand).
- `kyro-updater.key.pub`: **public** key, copied as-is (the base64 text of the file)
  into `apps/desktop/src-tauri/tauri.conf.json` → `plugins.updater.pubkey`. It is compiled
  into the binary: changing the key requires a version signed by the **old** key that embeds
  the new one.

Current key: generated on 2026-11-01, private key in `C:\Users\<you>\.tauri\kyro-updater.key`.

## 2. GitHub secrets

Repository → *Settings* → *Secrets and variables* → *Actions* → *New repository secret*:

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | the **contents** of the `kyro-updater.key` file (a single base64 line) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the current key has **no** password: do not create this secret (GitHub refuses an empty value; a missing secret equals `''` in the job). Create it only if the key is ever regenerated with a password |

`GITHUB_TOKEN` is provided by Actions (the job needs `permissions: contents: write`).

## 3. What the build produces

`tauri.conf.json` → `bundle.createUpdaterArtifacts: true`: each build signs, alongside the
installers, the update package for its platform:

| Platform | Package | `latest.json` key read by Kyro |
|---|---|---|
| Windows | `Kyro_X.Y.Z_x64-setup.exe` + `.sig` (NSIS, installed in passive / silent mode) | `windows-x86_64-nsis`, otherwise `windows-x86_64` |
| macOS | `Kyro_<arch>.app.tar.gz` + `.sig` | `darwin-aarch64-app` / `darwin-x86_64-app`, otherwise `darwin-<arch>` |
| Linux | `Kyro_X.Y.Z_amd64.AppImage` + `.sig` | `linux-x86_64-appimage`, otherwise `linux-x86_64` |

Kyro refuses a package of a type other than its installation (`.msi`, `.deb`, `.dmg`…), a URL
outside `https://github.com/shuntraa/kyro-wallet/releases/download/`, and a version that is
not strictly newer.

Local build **without** the key (development): the CLI refuses to sign; disable the update
artifacts for this build:

```sh
pnpm tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

## 4. Publishing

1. Bump the version everywhere (same number): `apps/desktop/src-tauri/tauri.conf.json`
   (`version`), `Cargo.toml` (`workspace.package.version`), `apps/desktop/package.json`.
2. Push tag `vX.Y.Z` → the job below builds the 3 platforms, signs, and creates the release
   as a **draft** with the packages, the `.sig` files and `latest.json`.
3. Check the draft (files, `latest.json`), then **publish** the release: this is what
   makes it "latest" and gets it installed by wallets (a pre-release is never picked up).

## 5. GitHub Actions job (to merge into `.github/workflows/release.yml`)

```yaml
on:
  push:
    tags: ['v*']

jobs:
  release:
    permissions:
      contents: write
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: windows-latest
            args: ''
          - platform: macos-latest          # Apple Silicon
            args: '--target aarch64-apple-darwin'
          - platform: macos-latest          # Intel
            args: '--target x86_64-apple-darwin'
          - platform: ubuntu-22.04
            args: ''
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4

      - name: Linux system dependencies
        if: matrix.platform == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf

      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.platform == 'macos-latest' && 'aarch64-apple-darwin,x86_64-apple-darwin' || '' }}

      - run: pnpm install --frozen-lockfile

      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          projectPath: apps/desktop
          tagName: ${{ github.ref_name }}
          releaseName: 'Kyro ${{ github.ref_name }}'
          releaseBody: 'Voir CHANGELOG.'
          releaseDraft: true
          prerelease: false
          # Uploads latest.json (versions, signatures, URLs) next to the packages.
          includeUpdaterJson: true
          args: ${{ matrix.args }}
```

`tauri-action` merges the `latest.json` of the 4 jobs into the same release. Pin the action to
a verified commit SHA before merging (project rule for dependencies).

## 6. Verifying after publication

```sh
curl -sL https://github.com/shuntraa/kyro-wallet/releases/latest/download/latest.json
```

must show the new version and one entry per platform. An installed wallet applies it on its
next close (check ≈ 45 s after launch), and shows "Kyro updated to X.Y.Z." at the
following startup.
