<p align="center"><img src="brand/kyro-mark-dark.svg" width="72" alt=""></p>

# Kyro Wallet

**Wallet crypto non-custodial, open source (GPLv3), pour Windows, macOS et Linux.**
Tes clés restent chiffrées sur ton appareil ; toutes les signatures se font dans un noyau Rust ; aucune télémétrie.

> ⚠️ **v0.1 — en développement, non auditée, testnet par défaut.** N'y mets pas d'argent que tu ne peux pas perdre.

## État réel (v0.1)

> Rien n'a encore été lancé **dans l'application réelle par un humain** et **aucune fenêtre de confirmation native n'a été cliquée**. Les envois réels marqués **✅ (headless)** ont été faits sans interface, par les **mêmes fonctions Rust** que l'application (construction, décodage, vérifications, signature, diffusion via Tor). Détail et légende : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#phases).

| Fonction | État | Comment c'est testé |
|---|---|---|
| Phrase BIP39 12/24 mots, coffre Argon2id + XChaCha20-Poly1305 | ✅ | vecteurs officiels Trezor, refus mot de passe / fichier modifié |
| Adresses BTC SegWit (BIP84) et Taproot (BIP86), EVM, Solana | ✅ | vecteurs BIP84/BIP86/SLIP-10, adresses de référence |
| Interface (écrans, auto-lock, presse-papier) | ⚠️ | parcourue en mode démo (backend simulé) ; jamais dans l'app réelle |
| Envoi Bitcoin | ⚠️ aucune diffusion testnet (aucun portefeuille public n'a de pièces testnet4) | sighash BIP143/BIP341 recalculés ; 2ᵉ fenêtre renforcée (script inconnu, OP_RETURN, entrée étrangère, frais > 100 sat/vB) ; lectures réelles via Tor (mempool .onion, Electrum testnet4, filtres compacts) |
| Envoi Ethereum / ERC-20 | ⚠️ aucune diffusion Sepolia (aucun portefeuille public n'a d'ETH Sepolia) | signature vérifiée contre une vraie transaction mainnet ; 2ᵉ fenêtre renforcée (appel de contrat, toute autorisation, valeur vers un contrat, chainId inconnu, frais élevés) |
| Chaînes EVM (Arbitrum, Optimism, Base, Polygon, BNB, Avalanche) | ⚠️ | registre + même adresse ; leurs testnets ne sont pas dans le registre de Kyro |
| Solana + SPL / Token-2022, devnet | ✅ (headless) | 7 transactions réelles par le chemin Rust de `sol_sign_tx` : SOL (`59eS4zti…NWwbvSag`), SPL et Token-2022 (mint créé + transfert), table d'adresses, **v0** avec table ; messages construits par le test, pas par l'adaptateur TS ; décodage aussi testé sur 6 vraies transactions et 9 000 messages mutés |
| Litecoin (BIP84 `ltc1`) | ✅ (headless) | une diffusion réelle testnet4 (`a45c9688…d431f0`) via Tor ; vecteurs Trust Wallet Core, Trezor, Electrum-LTC |
| Dogecoin (BIP44 P2PKH) | ⚠️ pas de serveur par défaut | vecteurs Trust Wallet Core, signature d'une vraie transaction mainnet vérifiée ; **jamais exécuté contre un serveur** |
| TRON (TRX, TRC-20 USDT), Nile | ✅ (headless) | diffusions réelles TRX (`4c280894…a59208`) et TRC-20 (`9863fe55…d2de1c`) ; vecteurs Trezor (signatures identiques), Trust Wallet Core |
| XRP Ledger (XRP + monnaies émises), testnet | ✅ (headless) | deux paiements réels validés (`02DFFDBC…57FB2EE` vers un compte inexistant, `2F324A9E…578EB0B7` avec tag) ; vecteurs Trezor, xrpl.js |
| Cardano (ADA + tokens natifs), preprod | ✅ (headless) | une diffusion réelle preprod (`d1d77438…f06c0d30`, envoi à soi-même, frais minimum) depuis l'adresse publique CIP-19 ; vecteurs CIP-0003, CIP-0019, Trezor (4 transactions, signatures identiques) |
| Ledger / Trezor (BTC, EVM, Solana) | ⚠️ jamais sur un vrai appareil ni un émulateur · ❌ Trezor Safe 7 | échanges APDU **enregistrés par Ledger** rejoués, firmware Trezor simulé, descripteurs ERC-20 Ledger vérifiés hors ligne |
| Tor intégré (Arti), échec fermé, circuits isolés par chaîne | ✅ lectures · ⚠️ jamais dans l'app réelle | vraies requêtes via Tor : mempool .onion, CoinGecko, Sepolia, Solana devnet, litecoinspace, TronGrid, XRPL, Koios |
| Serveurs personnalisés par chaîne | ✅ vérification réseau en direct · ⚠️ Bitcoin Core jamais testé contre un vrai nœud | Esplora et Electrum testnet4, RPC Sepolia, Solana devnet, rippled, Koios : bon réseau accepté, mauvais refusé (via Tor) |
| Filtres compacts BIP157/158 | ⚠️ désactivés par défaut (fonction `cbf`) jusqu'à revue (≥ 2026-11-11) | synchronisation réelle testnet4 via Tor, soldes identiques à mempool |
| Swap 0x / 1inch / LI.FI / Jupiter | ⚠️ | devis + approval exact testés contre des réponses simulées uniquement |
| Staking | ❌ | — |

## Installer les outils

- Rust (la version est épinglée dans `rust-toolchain.toml`, installée automatiquement par `rustup`)
- Node.js ≥ 22 et pnpm 11 (`corepack enable`)
- Windows : Visual Studio Build Tools (C++) et WebView2 · Linux : `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev` · macOS : Xcode Command Line Tools
- Hardware wallets : aucune bibliothèque système à installer (hidapi et libusb sont compilées avec Kyro). Linux : installer les règles udev de [Ledger](https://github.com/LedgerHQ/udev-rules) et de [Trezor](https://trezor.io/learn/a/udev-rules) pour l'accès USB sans root.

## Lancer

```bash
pnpm install --frozen-lockfile
cp .env.example .env          # optionnel : clés CoinGecko / 0x / 1inch / TronGrid (KYRO_TRONGRID_API_KEY)
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

Dépendance C embarquée sous licence différente : **libusb** (LGPL-2.1-or-later, liée statiquement pour Trezor), compatible avec la GPL-3.0 ; son code source est celui de la crate `libusb1-sys` 0.7.0.
