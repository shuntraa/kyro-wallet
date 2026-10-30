<p align="center"><img src="brand/kyro-mark-dark.svg" width="72" alt=""></p>

# Kyro Wallet

**Wallet crypto non-custodial, open source (GPLv3), pour Windows, macOS et Linux.**
Tes clés restent chiffrées sur ton appareil ; toutes les signatures se font dans un noyau Rust ; aucune télémétrie.

> ⚠️ **v0.1 — en développement, non auditée, testnet par défaut.** N'y mets pas d'argent que tu ne peux pas perdre.

## État réel (v0.1)

| Fonction | État | Testé |
|---|---|---|
| Phrase BIP39 12/24 mots, coffre Argon2id + XChaCha20-Poly1305 | ✅ | vecteurs officiels Trezor, refus mot de passe/fichier modifié |
| Adresses BTC SegWit (BIP84) et Taproot (BIP86), EVM, Solana | ✅ | vecteurs BIP84/BIP86/SLIP-10, adresses de référence |
| Signature PSBT Bitcoin, EIP-1559, message Solana (en Rust) | ✅ | sighash recalculés, vraie transaction mainnet Ethereum |
| Décodage avant signature (fenêtre native) | BTC ✅ · EVM ✅ · Solana ✅ (legacy + v0, tables d'adresses lues par Rust) | tests unitaires ; Solana : 6 vraies transactions devnet, comparaison au parseur officiel, 9 000 messages mutés |
| Coque Tauri : allowlist de commandes, CSP, réseau filtré, auto-lock, captures bloquées | ✅ compile, tests unitaires | pas encore exercée à la main contre un testnet |
| Interface (10 écrans) | ✅ | parcourue en mode démo (backend simulé), 0 erreur console |
| Envoi BTC / ETH / ERC-20 / SOL sur testnet | ⚠️ code complet | testé contre le backend simulé uniquement |
| Chaînes EVM (Arbitrum, Optimism, Base, Polygon, BNB, Avalanche) | ⚠️ registre + même adresse | non testé sur leurs testnets |
| Tokens SPL et Token-2022 (envoi) | ⚠️ code complet | testé contre le backend simulé ; encodage vérifié sur une vraie transaction devnet |
| Swap 0x / 1inch / LI.FI / Jupiter | ⚠️ devis + approval exact | testé contre des réponses simulées |
| Ledger / Trezor | ❌ pas encore | — |
| Litecoin, Dogecoin, Tron, Cardano, XRP | ❌ lecture seule (« Bientôt ») | — |
| Tor intégré (Arti), activé par défaut, échec fermé, circuits isolés par chaîne, mempool via .onion | ⚠️ code complet | tests unitaires + vraies requêtes via Tor (mempool .onion, CoinGecko, Solana devnet) ; UI vérifiée en mode démo ; pas encore lancé dans l'app réelle |
| Serveur perso par chaîne, filtres compacts BIP157/158 | ❌ pas encore | — |

## Installer les outils

- Rust (la version est épinglée dans `rust-toolchain.toml`, installée automatiquement par `rustup`)
- Node.js ≥ 22 et pnpm 11 (`corepack enable`)
- Windows : Visual Studio Build Tools (C++) et WebView2 · Linux : `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev` · macOS : Xcode Command Line Tools

## Lancer

```bash
pnpm install --frozen-lockfile
cp .env.example .env          # optionnel : clés CoinGecko / 0x / 1inch
pnpm dev                      # application Tauri (testnet)
pnpm --filter @kyro/desktop dev   # interface seule dans un navigateur, MODE DÉMO (aucune vraie clé)
```

## Vérifier

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
pnpm -r typecheck && pnpm -r test && pnpm lint:ts
cargo audit && cargo deny check && pnpm audit --prod
```

## Construire

```bash
pnpm build                    # installeurs (MSI/NSIS, DMG, AppImage/deb selon l'OS)
pnpm --filter @kyro/desktop tauri build --no-bundle   # binaire seul
```

## Architecture et sécurité

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — couches et responsabilités
- [docs/IPC.md](docs/IPC.md) — contrat entre l'interface et Rust
- [SECURITY.md](SECURITY.md) — modèle de menace, signaler une faille
- [docs/NETWORK.md](docs/NETWORK.md) — chaque serveur contacté et ce qu'il voit
- [docs/DESIGN.md](docs/DESIGN.md) — identité visuelle

## Licence

[GPL-3.0-or-later](LICENSE). Tout fork distribué doit rester open source.
