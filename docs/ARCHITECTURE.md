# Architecture de Kyro

## Vue d'ensemble

```
kyro/
├─ crates/wallet-core/        Rust pur : coffre, BIP39/32, dérivations, signatures, décodage. Sans réseau ni fichiers.
├─ apps/desktop/
│  ├─ src-tauri/              Coque Tauri 2 : commandes IPC, session + auto-lock, net_fetch filtré, dialogues natifs
│  └─ src/                    Interface React + TypeScript strict (aucun secret)
├─ packages/
│  ├─ shared/                 Types du contrat IPC + backend simulé pour le mode démo navigateur
│  ├─ chains/                 ChainAdapter : bitcoin (Esplora), evm (viem, registre de chaînes), solana (@solana/kit)
│  ├─ market/                 CoinGecko : top 200, graphiques, cache, backoff
│  └─ swap/                   SwapProvider : 0x, 1inch, Jupiter, LI.FI ; comparaison des devis ; approvals exacts
├─ brand/                     Logos et icônes (SVG)
└─ docs/                      IPC.md (contrat), NETWORK.md, DESIGN.md, ARCHITECTURE.md
```

## Qui fait quoi

| Étape d'un envoi | Couche |
|---|---|
| Construire la transaction non signée (UTXO, nonce, gas, message Solana) | TypeScript (`packages/chains`), via `net_fetch` |
| Décoder ce qui va réellement être signé | Rust (`wallet-core::decode`) |
| Demander le mot de passe | Interface → Rust (re-vérification Argon2id) |
| Confirmation finale | Rust → **fenêtre système native** avec le résumé décodé |
| Signer | Rust (`wallet-core::sign`), clé dérivée puis effacée |
| Diffuser | TypeScript, via `net_fetch` |

Le TypeScript peut donc se tromper ou être compromis sans pouvoir détourner des fonds : il ne voit jamais de clé, et Rust montre à l'utilisateur ce qui est signé.

## Phases

| Phase | Contenu | État v0.1 |
|---|---|---|
| 0 | Monorepo, coffre, BIP39/32, CI, interface | ✅ |
| 1 | Bitcoin SegWit + Taproot, Ethereum + ERC-20 (testnet d'abord) | ✅ testnet |
| 1.5 | Ledger, Trezor | ⏳ interface prévue, transport non branché |
| 2 | Arbitrum, Optimism, Base, Polygon, BNB Chain, Avalanche | ✅ registre (même adresse), à tester sur chaque testnet |
| 3 | Solana + SPL | ✅ SOL ; SPL en lecture |
| 4 | Litecoin, Dogecoin, Tron, Cardano, XRP… | ⏳ lecture seule (« Bientôt ») |
| Swap | 0x, 1inch, Jupiter, LI.FI | ✅ devis comparés ; exécution EVM |

*(Ce tableau est tenu à jour à chaque phase ; voir le README pour l'état exact.)*
