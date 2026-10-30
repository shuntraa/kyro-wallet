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

Légende : ✅ fonctionne de bout en bout **et** testé · ⚠️ code écrit, testé seulement contre un backend simulé · ❌ pas fait.

| Phase | Contenu | État réel |
|---|---|---|
| 0 | Monorepo, coffre chiffré, BIP39/32, CI, interface | ✅ noyau (47 tests, vecteurs officiels) · ⚠️ interface (mode démo) |
| 1 | Bitcoin SegWit + Taproot, Ethereum + ERC-20 | ⚠️ signature testée en Rust ; envoi complet jamais exécuté sur un testnet réel |
| 1.5 | Ledger, Trezor | ⚠️ côté Rust complet, testé sur échanges enregistrés et simulations ; pas d'appareil ni d'émulateur ; UI à faire |
| 2 | Arbitrum, Optimism, Base, Polygon, BNB Chain, Avalanche | ⚠️ registre et même adresse ; non testé sur leurs testnets |
| 3 | Solana + SPL | ⚠️ SOL (pas de décodage Rust) ; SPL en lecture seule |
| 4 | Litecoin, Dogecoin, Tron, Cardano, XRP | ⚠️ Litecoin et Dogecoin : Rust + adaptateurs TS complets, Litecoin diffusé pour de vrai sur testnet4 (une transaction), Dogecoin sans serveur par défaut ; UI à faire · ⚠️ TRON : Rust + adaptateur TS, diffusions TRX et TRC-20 réelles sur Nile ; UI en cours · ⚠️ XRP : Rust + adaptateur TS, deux paiements réels sur le testnet XRPL ; UI à faire · ❌ Cardano (« Bientôt ») |
| Swap | 0x, 1inch, Jupiter, LI.FI | ⚠️ devis et approvals testés contre des réponses simulées |
