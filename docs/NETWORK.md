# Requêtes réseau de Kyro

Kyro ne contacte **que** les serveurs ci-dessous, et seulement pour la raison indiquée. Il n'y a **aucune télémétrie**, aucun rapport de plantage automatique, aucune vérification de mise à jour en arrière-plan.

L'interface (webview) ne peut joindre aucun serveur : la CSP n'autorise que le canal IPC de Tauri. Toutes les requêtes passent par la commande Rust `net_fetch`, qui :
- refuse tout hôte absent de cette liste (et de tes RPC personnalisés) ;
- n'accepte que HTTPS (seule exception : le service onion de mempool listé plus bas, en `http://` et **uniquement via Tor**), refuse les redirections vers un hôte hors liste ;
- plafonne la réponse à 5 Mo et la durée à 20 s ;
- met en cache et limite le débit (CoinGecko) ;
- passe **par Tor intégré par défaut** (voir « Modes » ci-dessous).

## Modes : Tor (par défaut) ou en clair

Kyro embarque un client Tor (Arti, de The Tor Project). Il démarre en arrière-plan à l'ouverture de l'app ; son état est affiché par l'interface.

| | Mode Tor (défaut) | Mode clair (désactivé explicitement par toi) |
|---|---|---|
| Ton adresse IP | **Cachée** : le serveur voit l'IP d'un relais de sortie Tor. Ton fournisseur d'accès voit seulement que tu utilises Tor. | Visible par chaque serveur contacté et par ton fournisseur d'accès (qui voit les noms d'hôtes). |
| Contenu des requêtes | Chiffré de bout en bout en TLS jusqu'au serveur (le relais de sortie ne voit que le nom d'hôte et le volume). | Chiffré en TLS. |
| Tes adresses publiques, tes transactions | **Toujours visibles par le serveur interrogé** : Tor cache *qui* tu es sur le réseau, pas *ce que* tu demandes. | Visibles par le serveur interrogé, et associées à ton IP. |
| Liens entre activités | Chaque famille — **bitcoin**, **evm**, **solana**, **marché** (CoinGecko), **swap** — utilise ses propres circuits isolés : un relais de sortie ou un serveur ne peut pas relier, par le circuit, ta consultation Bitcoin et ta consultation Solana. | Toutes les requêtes partent de la même IP. |
| Panne | **Échec fermé** : si Tor n'est pas prêt dans les 60 s, la requête échoue (`TOR_UNAVAILABLE`) et **rien n'est envoyé en clair**. Aucun repli automatique. | — |

Par serveur, en mode Tor : CoinGecko voit les cryptos et la devise demandées ; mempool, les RPC EVM et Solana voient les adresses et transactions demandées ; les API de swap voient les tokens, montants et l'adresse destinataire — mais aucun ne voit ton IP, et deux familles différentes ne partagent jamais un circuit.

**Bitcoin en mode Tor : service onion de mempool.** En mode Tor, Rust réécrit automatiquement `https://mempool.space/…` en `http://mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion/…` (même chemin). La connexion reste **entièrement dans le réseau Tor** : aucun relais de sortie n'intervient, donc aucun relais ne voit ni le nom d'hôte, ni le volume, ni ne peut altérer le trafic. Le `http://` n'est pas un affaiblissement : une adresse onion *est* la clé publique du service, que le protocole authentifie, et la connexion est chiffrée de bout en bout — ce qui remplace TLS. Cette exception vaut **uniquement** pour cette adresse onion précise et **uniquement via Tor** ; toute autre URL `http://` reste refusée, et toute adresse `.onion` est refusée en mode clair. Mempool voit toujours les adresses et transactions demandées, mais ni ton IP ni celle d'un relais de sortie.

Source de l'adresse onion : l'en-tête HTTP `Onion-Location` renvoyé par https://mempool.space/ (vérifié le 30/10/2026, authentifié par le certificat TLS de mempool.space) : `Onion-Location: http://mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion/`.

Repasser en clair est un choix explicite dans les Réglages (confirmation demandée). Tes RPC personnalisés passent aussi par Tor quand il est activé. Les données de Tor (consensus, état des gardes) sont stockées dans le dossier de l'app (`tor/`).

Pourquoi l'onion : `mempool.space` ne répond pas aux relais de sortie Tor (délai dépassé à la sortie sur toutes nos tentatives, 30/10/2026) ; son service onion répond.

## Ce que chaque serveur voit

En mode clair, tout serveur contacté voit ton **adresse IP** ; en mode Tor (défaut), il voit celle d'un relais de sortie. Dans les deux modes, les nœuds blockchain voient les **adresses publiques** dont tu demandes le solde. Pour éviter ça : utilise **tes propres nœuds** (Réglages → Réseaux et RPC).

| Hôte | Pourquoi | Données envoyées |
|---|---|---|
| `api.coingecko.com` (`pro-api.coingecko.com` avec clé) | Prix du top 200, variations, graphiques | Devise d'affichage, identifiants de cryptos. **Aucune adresse.** |
| `mempool.space` (mode clair) | Bitcoin : UTXO, historique, frais, diffusion des transactions | Tes adresses Bitcoin, tes transactions signées |
| `mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion` (mode Tor uniquement, `http://`) | Même service que `mempool.space`, via son service onion officiel | Tes adresses Bitcoin, tes transactions signées (jamais ton IP) |
| `ethereum-sepolia-rpc.publicnode.com` / `ethereum-rpc.publicnode.com` | Ethereum : soldes, nonce, gas, diffusion | Ton adresse EVM, tes transactions signées |
| `arbitrum-one-rpc`, `optimism-rpc`, `base-rpc`, `polygon-bor-rpc`, `bsc-rpc`, `avalanche-c-chain-rpc` `.publicnode.com` | Chaînes EVM (phase 2), mêmes usages | Ton adresse EVM, tes transactions signées |
| `api.devnet.solana.com` / `api.mainnet-beta.solana.com` | Solana : solde, blockhash, diffusion ; lecture par Rust des tables d'adresses (ALT) d'une transaction v0 avant de l'afficher et de la signer | Ton adresse Solana, tes transactions signées, les adresses des tables utilisées par la transaction à signer |
| `api.0x.org` | Devis de swap EVM (si clé configurée) | Tokens, montant, ton adresse (destinataire du swap) |
| `api.1inch.dev` | Devis de swap EVM (si clé configurée) | Tokens, montant, ton adresse |
| `li.quest` | Devis de swap cross-chain | Tokens, montant, chaînes, ton adresse |
| `lite-api.jup.ag` | Devis de swap Solana | Tokens, montant, ton adresse |

Les devis de swap ne sont demandés que lorsque tu ouvres l'écran Swap et saisis un montant.

Les tables d'adresses (ALT) d'une transaction Solana v0 sont lues par Rust auprès du RPC Solana (celui des réglages, sinon le RPC par défaut ci-dessus), jamais transmises par l'interface. Kyro fait confiance à ce RPC pour leur contenu, comme pour les soldes ; une table introuvable, désactivée ou incomplète bloque l'aperçu et la signature.

## Ajouter un serveur

Une PR qui ajoute un hôte doit modifier **en même temps** cette page, `docs/IPC.md` et l'allowlist Rust, et justifier le besoin. Une requête non listée ici est un bug de sécurité.
