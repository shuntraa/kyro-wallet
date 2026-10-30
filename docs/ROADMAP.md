# Feuille de route — partie B

Étude de faisabilité du 30/10/2026 (versions et dépendances vérifiées sur crates.io). Contraintes : pas de crypto maison, pas de `k256` / `crypto-bigint` 0.5 (RUSTSEC-2026-0387), licences compatibles GPL, Rust 1.97.1, versions publiées depuis au moins deux semaines.

## Ordre et estimation

| # | Étape | Approche retenue | Jours |
|---|---|---|---|
| B1 | Décodage Solana + envoi SPL | décodeur écrit à la main (format documenté), `solana-message` en dépendance de test uniquement | 3–4 |
| B4a | Litecoin, Dogecoin | crate `bitcoin` (sighash BIP143/legacy) + encodage d'adresses maison sur `bech32`/`bs58` | 4–6 |
| B2a | Tor intégré | `arti-client` 0.47 (rustls/ring, SQLite statique), client HTTP dédié sur hyper, **fail closed** | 6–10 |
| B2b | Serveurs perso Bitcoin | Electrum TLS via Tor (`electrum-client`), `bdk_wallet` en lecture seule (persisté dans le coffre), Bitcoin Core via `corepc-types` | 8–12 |
| B3a | Ledger BTC, Trezor BTC/EVM | `ledger_bitcoin_client` (officiel) + `ledger-transport-hid`, `trezor-client` (officiel) | 8–12 |
| B4b | Tron | protobuf via `prost` (dérivations à la main, pas de `protoc`), construction locale de la transaction | 5–7 |
| B4c | XRP | codec STObject maison testé sur les fixtures officielles `ripple-binary-codec` | 6–9 |
| B3b | Ledger EVM et Solana | APDU d'après les specs officielles des apps | 8–12 |
| B4d | Cardano | `pallas` 1.4 + `ed25519-bip32` (Icarus), vecteurs CIP-0003/0019 | 10–15 |

**Total estimé : 60 à 90 jours de travail.**

## Ce qui n'est pas faisable de façon sûre aujourd'hui

- Signeurs Ledger/Trezor d'alloy et crate `xrpl-rust` : ils réintroduisent `k256` ou `crypto-bigint` 0.5.
- `solana-remote-wallet` : exige Rust 1.98.1.
- Filtres compacts BIP157/158 (Kyoto) **à travers le Tor intégré** : ne sait passer que par un proxy SOCKS local, exposé aux autres programmes de la machine. Possible avec un Tor système ; sinon reporté.
- Clear signing ERC-20 / SPL sur Ledger : dépend des descripteurs signés du service de métadonnées de Ledger ; sans eux l'appareil affiche des données brutes.
- Signature Solana sur Trezor (support expérimental) et modèles Trezor à canal THP (non vérifié).
- Testnet Dogecoin via une API publique : aucune ne fonctionne ; il faut un nœud testnet perso.
- Dérivation Cardano sur du code audité : la seule implémentation Icarus maintenue s'appuie sur `cryptoxide`, non audité (atténué par les vecteurs CIP et une vérification croisée avec ed25519-dalek).
- `arti` vend une dépendance `rsa` 0.9 (RUSTSEC-2023-0071, attaque Marvin) : non exploitable ici (vérification RSA uniquement), mais à ignorer explicitement et à documenter dans `cargo audit`.
