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

En mode clair, tout serveur contacté voit ton **adresse IP** ; en mode Tor (défaut), il voit celle d'un relais de sortie. Dans les deux modes, les nœuds blockchain voient les **adresses publiques** dont tu demandes le solde. Pour éviter ça : utilise **tes propres nœuds** (Réglages → Réseaux et serveurs).

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

## Serveurs personnalisés (Réglages → Réseaux)

Tu peux remplacer le serveur par défaut de chaque chaîne : Bitcoin (Esplora, Electrum ou ton nœud Bitcoin Core), chaque chaîne EVM, chaque cluster Solana. Règles communes :
- un serveur personnalisé n'est autorisé **que pour sa propre famille** et passe par les **circuits Tor isolés** de cette famille ;
- il est vérifié à l'enregistrement : il doit être sur le bon réseau (genesis Bitcoin, `eth_chainId`, genesis Solana), sinon il est refusé ;
- dès qu'il est configuré, le serveur par défaut de cette chaîne est **refusé** : si ton serveur tombe, Kyro affiche une erreur (`SERVER_UNREACHABLE`) et **ne se rabat jamais** sur le serveur par défaut — sinon tes adresses partiraient chez le tiers que tu as justement voulu éviter ;
- jamais d'identifiants dans une URL ; `http://` en clair n'est permis que pour une adresse `.onion` via Tor (le protocole onion authentifie le service et chiffre de bout en bout) et, pour Bitcoin Core seulement, pour une adresse locale.

| Serveur | Mode Tor (défaut) : ce que le serveur voit | Mode clair : ce que le serveur voit | Ne voit jamais |
|---|---|---|---|
| mempool.space (défaut Bitcoin) | Ton adresse Bitcoin et tes transactions, via son service **.onion** : aucun relais de sortie, aucune IP | Tes adresses, tes transactions **et ton IP** | Ta phrase, tes clés |
| Esplora personnalisé (`https://` ou `.onion`) | Tes adresses et transactions ; l'IP d'un relais de sortie (ou aucune si `.onion`) | Tes adresses, transactions et ton IP ; `.onion` refusé | Ta phrase, tes clés |
| Electrum (TLS, ou TCP vers un `.onion`) | Tes *script hashes* (équivalent de tes adresses), tes transactions ; l'IP d'un relais de sortie (aucune si `.onion`) | Idem **et ton IP** ; `.onion` refusé | Ta phrase, tes clés |
| Bitcoin Core **local/LAN** (127.0.0.0/8, ::1, RFC 1918, fc00::/7) | Joint **directement, sans Tor** (Tor ne peut pas atteindre ton réseau local, et rien ne sort de ta machine/ton réseau) : ton propre nœud voit tes descripteurs publics (xpub) et tes transactions | Idem | Ta phrase, tes clés privées (portefeuille de surveillance sans clé privée) |
| Bitcoin Core **distant** (`https://` ou `.onion`) | Tes descripteurs publics (xpub : **tout l'historique de ton compte**, présent et futur), tes transactions ; l'IP d'un relais de sortie (aucune si `.onion`) | Idem **et ton IP** ; `.onion` refusé | Ta phrase, tes clés privées |
| RPC EVM personnalisé | Ton adresse EVM, tes transactions signées ; l'IP d'un relais de sortie | Idem **et ton IP** | Ta phrase, tes clés |
| RPC Solana personnalisé | Ton adresse Solana, tes transactions signées, les tables d'adresses lues ; l'IP d'un relais de sortie | Idem **et ton IP** | Ta phrase, tes clés |

### Bitcoin par filtres compacts (BIP157/158) — fonction `cbf`, désactivée par défaut jusqu'à revue

Kyro télécharge les **filtres de blocs** auprès de pairs Bitcoin, vérifie **sur ta machine** quels blocs concernent tes scripts (BIP84 et BIP86, réception et monnaie, avec une marge d'adresses inutilisées), puis ne télécharge que ces blocs. Aucun serveur n'apprend tes adresses.

| | Mode Tor (défaut) | Mode clair (choix explicite) |
|---|---|---|
| Transport | **Uniquement via Tor** : la bibliothèque P2P ne peut sortir que par un pont SOCKS interne (127.0.0.1, port aléatoire, actif seulement pendant une synchronisation ou une diffusion) qui n'accepte que les pairs que Kyro lui a donnés et refuse tout le reste (y compris les noms d'hôtes : aucune requête DNS). Pairs `.onion` d'abord, pairs IPv4 via un relais de sortie seulement en secours. Échec fermé : jamais de connexion directe. | Connexion directe aux pairs IPv4/IPv6 ; les pairs `.onion` sont ignorés. |
| Pairs | Liste fournie par Kyro (pairs servant les filtres, vérifiés le 30/10/2026 : testnet4 11 pairs dont 6 `.onion` ; mainnet 14 pairs dont 11 `.onion`, sur un échantillon de 75) + les tiens. **Pas de seeds DNS, pas de découverte par les pairs.** | Idem, IP seulement. |
| Ce que voit un pair | Une connexion venant de Tor (ni ton IP, ni de quoi te relier à tes autres activités) ; **quels blocs tu télécharges en entier** : un signal faible mais réel (un pair qui voit les mêmes demandes répétées peut deviner que tu as une transaction dans ces blocs). Les filtres eux-mêmes sont identiques pour tout le monde et ne révèlent rien. | Idem **et ton IP**. |
| Ce que voit ton FAI | Que tu utilises Tor. | Que tu parles le protocole Bitcoin avec ces pairs. |
| Diffusion | Ta transaction est envoyée à un pair via Tor. | Envoyée directement à un pair. |

Limites honnêtes :
- **Pas de mempool** : un paiement reçu n'apparaît qu'une fois miné ; tes propres envois apparaissent « en attente » jusqu'à leur inclusion.
- **Frais** : moyenne des frais réellement payés (frais ÷ poids) dans les 3 derniers blocs, avec le minimum de relais des pairs comme plancher. Ce n'est pas une estimation de mempool ; tu peux toujours saisir un tarif manuel.
- **Première synchronisation** : en-têtes depuis le bloc genesis puis filtres depuis ta « date de naissance » (`birthHeight`) ; elle peut prendre plusieurs minutes via Tor. Les en-têtes récents et l'avancement sont gardés dans le dossier de l'app (`cbf/`).

Remarques :
- Avec Electrum ou Esplora, chaque consultation porte sur une adresse : le serveur peut regrouper tes adresses s'il les voit dans la même session. Avec Bitcoin Core, le nœud connaît ton xpub : n'utilise un nœud **distant** que s'il t'appartient.
- Electrum : certificat validé normalement (autorités de certification), ou **épinglé** par son empreinte SHA-256 pour les serveurs auto-signés (Kyro affiche l'empreinte et te demande de la confirmer). Un certificat non validé et non épinglé n'est jamais accepté.
- Un nœud Bitcoin Core local est joint en `http://` sur ta machine ou ton réseau local, sans Tor ni proxy.

## Ajouter un serveur

Une PR qui ajoute un hôte doit modifier **en même temps** cette page, `docs/IPC.md` et l'allowlist Rust, et justifier le besoin. Une requête non listée ici est un bug de sécurité.
