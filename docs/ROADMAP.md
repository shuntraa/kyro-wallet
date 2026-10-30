# Feuille de route — partie B

Étude de faisabilité du 30/10/2026 (versions et dépendances vérifiées sur crates.io). Contraintes : pas de crypto maison, pas de `k256` / `crypto-bigint` 0.5 (RUSTSEC-2026-0387), licences compatibles GPL, Rust 1.97.1, versions publiées depuis au moins deux semaines.

## Ordre et estimation

| # | Étape | Approche retenue | Jours |
|---|---|---|---|
| B1 | Décodage Solana + envoi SPL | décodeur écrit à la main (format documenté), `solana-message` en dépendance de test uniquement | 3–4 |
| B4a | Litecoin, Dogecoin | crate `bitcoin` (sighash BIP143/legacy) + encodage d'adresses maison sur `bech32`/`bs58` | 4–6 |
| B2a | Tor intégré | `arti-client` 0.47 (rustls/ring, SQLite statique), client HTTP dédié sur hyper, **fail closed** | 6–10 |
| B2b | Serveurs perso Bitcoin | Electrum TLS via Tor (`electrum-client`), `bdk_wallet` en lecture seule (persisté dans le coffre), Bitcoin Core via `corepc-types` | 8–12 |
| B3a | Ledger BTC, Trezor BTC/EVM | `ledger_bitcoin_client` (officiel) + transport HID maison sur `hidapi` (au lieu de `ledger-transport-hid` : délais bornés, annulation), `trezor-client` (officiel, messages + framing ; transport USB maison sur `rusb`) — **fait côté Rust (B3), à tester sur appareil** | 8–12 |
| B4b | Tron | protobuf via `prost` (dérivations à la main, pas de `protoc`), construction locale de la transaction | 5–7 |
| B4c | XRP | codec STObject maison testé sur les fixtures officielles `ripple-binary-codec` | 6–9 |
| B3b | Ledger EVM et Solana | APDU d'après les specs officielles des apps — **fait côté Rust (B3), à tester sur appareil** | 8–12 |
| B4d | Cardano | `pallas` 1.4 + `ed25519-bip32` (Icarus), vecteurs CIP-0003/0019 | 10–15 |

**Total estimé : 60 à 90 jours de travail.**

## Suivis B2c (filtres compacts)

- **Activer `cbf` par défaut le 2026-11-11 ou après**, une fois `bip157 0.8.1` (publiée le 2026-10-28) et `bitcoin-address-book 0.2.2` (2026-10-23) âgées d'au moins deux semaines : relancer `cargo audit` et `cargo deny check` avec la fonction, et relire le diff de chaque crate par rapport à la version revue le 2026-10-30 (pas de `build.rs`, pas de macro procédurale, accès fichiers uniquement dans du code mort ou des tests).
- **Proposer en amont (bip157) l'authentification SOCKS5 RFC 1929** (nom d'utilisateur / mot de passe) : notre pont pourrait alors exiger un jeton aléatoire par lancement, en plus de la liste de pairs. Ne pas maintenir de correctif local.

## Ce qui n'est pas faisable de façon sûre aujourd'hui

- Signeurs Ledger/Trezor d'alloy et crate `xrpl-rust` : ils réintroduisent `k256` ou `crypto-bigint` 0.5.
- `solana-remote-wallet` : exige Rust 1.98.1.
- ~~Filtres compacts BIP157/158 à travers le Tor intégré~~ : fait en B2c derrière la fonction `cbf` (pont SOCKS interne verrouillé sur la liste de pairs, voir NETWORK.md).
- Clear signing ERC-20 / SPL sur Ledger : dépend des descripteurs signés du service de métadonnées de Ledger ; sans eux l'appareil affiche des données brutes. B3 embarque trois descripteurs ERC-20 vérifiés (USDC, USDT mainnet ; tUSDC Sepolia) ; les autres tokens et SPL restent en blind signing (dialogue renforcé).
- Signature Solana sur Trezor (support expérimental). ~~Modèles Trezor à canal THP~~ : Trezor Safe 7 fait côté Rust (`hw/thp.rs`, appairage par code ; testé contre le code THP côté appareil de Trezor, pas sur un vrai Safe 7 ; UI de saisie du code à faire, IPC.md §2.3).
- Contrôle d'authenticité Trezor (`AuthenticateDevice`, Safe 3/5/7) : chaînes X.509 P-256 / Ed25519 / ML-DSA-44 jusqu'aux racines Trezor ; demande un parseur X.509, `ml-dsa` (RustCrypto, 0.1, jeune) et un P-256 sans `crypto-bigint` 0.5 (avis RUSTSEC-2026-0387). Non fait : à faire dans Trezor Suite.
- Testnet Dogecoin via une API publique : aucune ne fonctionne ; il faut un nœud testnet perso.
- Dérivation Cardano sur du code audité : la seule implémentation Icarus maintenue s'appuie sur `cryptoxide`, non audité (atténué par les vecteurs CIP et une vérification croisée avec ed25519-dalek).
- `arti` vend une dépendance `rsa` 0.9 (RUSTSEC-2023-0071, attaque Marvin) : non exploitable ici (vérification RSA uniquement), mais à ignorer explicitement et à documenter dans `cargo audit`.
