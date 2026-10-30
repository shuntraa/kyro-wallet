# Requêtes réseau de Kyro

Kyro ne contacte **que** les serveurs ci-dessous, et seulement pour la raison indiquée. Il n'y a **aucune télémétrie**, aucun rapport de plantage automatique, aucune vérification de mise à jour en arrière-plan.

L'interface (webview) ne peut joindre aucun serveur : la CSP n'autorise que le canal IPC de Tauri. Toutes les requêtes passent par la commande Rust `net_fetch`, qui :
- refuse tout hôte absent de cette liste (et de tes RPC personnalisés) ;
- n'accepte que HTTPS, refuse les redirections vers un hôte hors liste ;
- plafonne la réponse à 5 Mo et la durée à 20 s ;
- met en cache et limite le débit (CoinGecko).

## Ce que chaque serveur voit

Tout serveur contacté voit ton **adresse IP**. Les nœuds blockchain voient aussi les **adresses publiques** dont tu demandes le solde. Pour éviter ça : utilise **tes propres nœuds** (Réglages → Réseaux et RPC) et/ou un VPN ou Tor au niveau système.

| Hôte | Pourquoi | Données envoyées |
|---|---|---|
| `api.coingecko.com` (`pro-api.coingecko.com` avec clé) | Prix du top 200, variations, graphiques | Devise d'affichage, identifiants de cryptos. **Aucune adresse.** |
| `mempool.space` | Bitcoin : UTXO, historique, frais, diffusion des transactions | Tes adresses Bitcoin, tes transactions signées |
| `ethereum-sepolia-rpc.publicnode.com` / `ethereum-rpc.publicnode.com` | Ethereum : soldes, nonce, gas, diffusion | Ton adresse EVM, tes transactions signées |
| `arbitrum-one-rpc`, `optimism-rpc`, `base-rpc`, `polygon-bor-rpc`, `bsc-rpc`, `avalanche-c-chain-rpc` `.publicnode.com` | Chaînes EVM (phase 2), mêmes usages | Ton adresse EVM, tes transactions signées |
| `api.devnet.solana.com` / `api.mainnet-beta.solana.com` | Solana : solde, blockhash, diffusion | Ton adresse Solana, tes transactions signées |
| `api.0x.org` | Devis de swap EVM (si clé configurée) | Tokens, montant, ton adresse (destinataire du swap) |
| `api.1inch.dev` | Devis de swap EVM (si clé configurée) | Tokens, montant, ton adresse |
| `li.quest` | Devis de swap cross-chain | Tokens, montant, chaînes, ton adresse |
| `lite-api.jup.ag` | Devis de swap Solana | Tokens, montant, ton adresse |

Les devis de swap ne sont demandés que lorsque tu ouvres l'écran Swap et saisis un montant.

## Ajouter un serveur

Une PR qui ajoute un hôte doit modifier **en même temps** cette page, `docs/IPC.md` et l'allowlist Rust, et justifier le besoin. Une requête non listée ici est un bug de sécurité.
