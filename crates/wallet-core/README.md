# wallet-core

Cœur cryptographique de Kyro, en Rust pur. Licence GPL-3.0-or-later. Le contrat public est dans `docs/IPC.md` §1.

## Ce qu'il fait

- **Phrase de récupération BIP39** (anglais, 12 ou 24 mots, OsRng) : génération, validation du checksum, calcul de la seed.
- **Coffre chiffré** : Argon2id (256 Mio, t=3, p=4) → XChaCha20-Poly1305. Le sel et le nonce sont aléatoires ; l'en-tête (version, paramètres KDF, sel) est authentifié via l'AAD. Sérialisé en JSON avec des champs base64.
- **Bitcoin** : comptes BIP84 (P2WPKH) et BIP86 (P2TR), xpub, adresses, signature PSBT et résumé (sorties, monnaie rendue, frais).
- **EVM** : adresse `m/44'/60'/0'/0/i` (EIP-55), signature EIP-1559 (type 2), décodage des transferts natifs, des appels ERC-20 `transfer`/`approve` (avec détection des approbations illimitées) et des autres appels de contrat.
- **Solana** : dérivation SLIP-10 ed25519 `m/44'/501'/i'/0'` (même convention que Phantom et Solflare), signature ed25519 d'un message de transaction.
- **Décodage Solana** (legacy et v0, tables d'adresses) : transferts SOL et SPL/Token-2022, délégations, comptes token associés, frais prioritaires, mémos. Ce qui n'est pas reconnu est signalé et exige une confirmation de plus. Vérifié sur de vraies transactions devnet et comparé à la crate de référence `solana-message` (en dev-dependency seulement).

## Ce qu'il ne fait jamais

- Aucun accès réseau ni fichier, pas d'async, pas de Tauri. La crate est purement synchrone.
- Aucune crypto maison : on utilise uniquement `bip39`, `bitcoin`/`secp256k1` (libsecp256k1, aussi pour l'EVM), `sha3` (Keccak), `alloy-rlp`, `uint`, `ed25519-dalek`, `ed25519-dalek-bip32`, `argon2` et `chacha20poly1305`.
- Aucun secret dans les logs : les `Debug` sont masqués, et les clés sont dérivées à chaque appel puis effacées (`zeroize`).
- Aucune panique sur une entrée utilisateur : chaque erreur remonte comme `wallet_core::Error`.
- Ne signe pas les PSBT trop permissives : un input n'est signé que si les conditions suivantes sont toutes remplies :
  - son empreinte et son chemin correspondent à ce portefeuille et au réseau ;
  - la clé dérivée correspond au script ;
  - le sighash vaut ALL ou DEFAULT.

  Les arbres de scripts Taproot sont refusés.

## Tests

```sh
cargo test   --manifest-path crates/wallet-core/Cargo.toml
cargo clippy --manifest-path crates/wallet-core/Cargo.toml --all-targets -- -D warnings
cargo test   --manifest-path crates/wallet-core/Cargo.toml --release -- --ignored  # Argon2 en paramètres de production
```

Les tests utilisent les vecteurs officiels suivants :
- BIP39 (Trezor) ;
- BIP32 (vecteurs 1 et 2) ;
- BIP84 et BIP86 ;
- SLIP-10 ed25519.

S'y ajoutent l'adresse EVM et l'adresse Solana de la phrase « abandon … about », ainsi que des allers-retours de signature EIP-1559 et PSBT (vérifiés par récupération de clé ou par vérification secp256k1) et des tests de falsification du coffre.
