# Publier une version de Kyro

Les wallets installés se mettent à jour seuls depuis les releases GitHub de
`shuntraa/kyro-wallet` (voir SECURITY.md « Mises à jour automatiques »). Ils n'installent
qu'un paquet **signé par la clé de mise à jour de Kyro** et plus récent que la version en cours.

## 1. La clé de signature (une seule fois)

Générée avec la CLI Tauri, sans mot de passe :

```sh
cd apps/desktop
pnpm tauri signer generate --ci -w "C:\Users\<toi>\.tauri\kyro-updater.key"
```

- `kyro-updater.key` : clé **privée**. Jamais dans le dépôt, jamais affichée, gardée hors ligne
  (copie de sauvegarde). La perdre = les wallets installés ne peuvent plus recevoir de mise à
  jour (il faudrait réinstaller à la main une version portant une nouvelle clé publique).
- `kyro-updater.key.pub` : clé **publique**, recopiée telle quelle (le texte base64 du fichier)
  dans `apps/desktop/src-tauri/tauri.conf.json` → `plugins.updater.pubkey`. Elle est compilée
  dans le binaire : changer de clé exige une version signée par l'**ancienne** clé qui embarque
  la nouvelle.

Clé actuelle : générée le 01/11/2026, privée dans `C:\Users\<you>\.tauri\kyro-updater.key`.

## 2. Secrets GitHub

Dépôt → *Settings* → *Secrets and variables* → *Actions* → *New repository secret* :

| Secret | Valeur |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | le **contenu** du fichier `kyro-updater.key` (une ligne base64) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | la clé actuelle n'a **pas** de mot de passe : ne pas créer ce secret (GitHub refuse une valeur vide ; un secret absent vaut `''` dans le job). À créer seulement si la clé est un jour régénérée avec un mot de passe |

`GITHUB_TOKEN` est fourni par Actions (le job a besoin de `permissions: contents: write`).

## 3. Ce que le build produit

`tauri.conf.json` → `bundle.createUpdaterArtifacts: true` : chaque build signe, à côté des
installeurs, le paquet de mise à jour de sa plateforme :

| Plateforme | Paquet | Clé de `latest.json` lue par Kyro |
|---|---|---|
| Windows | `Kyro_X.Y.Z_x64-setup.exe` + `.sig` (NSIS, installé en mode passif / silencieux) | `windows-x86_64-nsis`, sinon `windows-x86_64` |
| macOS | `Kyro_<arch>.app.tar.gz` + `.sig` | `darwin-aarch64-app` / `darwin-x86_64-app`, sinon `darwin-<arch>` |
| Linux | `Kyro_X.Y.Z_amd64.AppImage` + `.sig` | `linux-x86_64-appimage`, sinon `linux-x86_64` |

Kyro refuse un paquet d'un autre type que son installation (`.msi`, `.deb`, `.dmg`…), une URL
hors de `https://github.com/shuntraa/kyro-wallet/releases/download/`, et une version qui n'est
pas strictement plus récente.

Build local **sans** la clé (développement) : la CLI refuse de signer ; désactiver les artefacts
de mise à jour pour ce build :

```sh
pnpm tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

## 4. Publier

1. Monter la version partout (même numéro) : `apps/desktop/src-tauri/tauri.conf.json`
   (`version`), `Cargo.toml` (`workspace.package.version`), `apps/desktop/package.json`.
2. Tag `vX.Y.Z` poussé → le job ci-dessous construit les 3 plateformes, signe, crée la release
   en **brouillon** avec les paquets, les `.sig` et `latest.json`.
3. Vérifier le brouillon (fichiers, `latest.json`), puis **publier** la release : c'est ce qui la
   rend « latest » et la fait installer par les wallets (une pré-release n'est jamais prise).

## 5. Job GitHub Actions (à fusionner dans `.github/workflows/release.yml`)

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

`tauri-action` fusionne le `latest.json` des 4 jobs dans la même release. Épingler l'action sur
un SHA de commit vérifié avant de fusionner (règle du projet pour les dépendances).

## 6. Vérifier après publication

```sh
curl -sL https://github.com/shuntraa/kyro-wallet/releases/latest/download/latest.json
```

doit montrer la nouvelle version et une entrée par plateforme. Un wallet installé l'applique à
sa prochaine fermeture (vérification ≈ 45 s après son lancement), et affiche « Kyro a été mis à
jour en version X.Y.Z » au démarrage suivant.
