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
| Liens entre activités | Chaque famille — **bitcoin**, **litecoin**, **dogecoin**, **tron**, **xrp**, **cardano**, **evm**, **solana**, **marché** (CoinGecko), **swap** — utilise ses propres circuits isolés : un relais de sortie ou un serveur ne peut pas relier, par le circuit, ta consultation Bitcoin et ta consultation Solana. | Toutes les requêtes partent de la même IP. |
| Panne | **Échec fermé** : si Tor n'est pas prêt dans les 60 s, la requête échoue (`TOR_UNAVAILABLE`) et **rien n'est envoyé en clair**. Aucun repli automatique. | — |

Par serveur, en mode Tor : CoinGecko voit les cryptos et la devise demandées ; mempool, litecoinspace, TronGrid, les serveurs XRPL, Koios (Cardano), les RPC EVM et Solana voient les adresses et transactions demandées ; les API de swap voient les tokens, montants et l'adresse destinataire — mais aucun ne voit ton IP, et deux familles différentes ne partagent jamais un circuit.

**Bitcoin en mode Tor : service onion de mempool.** En mode Tor, Rust réécrit automatiquement `https://mempool.space/…` en `http://mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion/…` (même chemin). La connexion reste **entièrement dans le réseau Tor** : aucun relais de sortie n'intervient, donc aucun relais ne voit ni le nom d'hôte, ni le volume, ni ne peut altérer le trafic. Le `http://` n'est pas un affaiblissement : une adresse onion *est* la clé publique du service, que le protocole authentifie, et la connexion est chiffrée de bout en bout — ce qui remplace TLS. Cette exception vaut **uniquement** pour cette adresse onion précise et **uniquement via Tor** ; toute autre URL `http://` reste refusée, et toute adresse `.onion` est refusée en mode clair. Mempool voit toujours les adresses et transactions demandées, mais ni ton IP ni celle d'un relais de sortie.

Source de l'adresse onion : l'en-tête HTTP `Onion-Location` renvoyé par https://mempool.space/ (vérifié le 30/10/2026, authentifié par le certificat TLS de mempool.space) : `Onion-Location: http://mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion/`.

Repasser en clair est un choix explicite dans les Réglages (confirmation demandée). Tes RPC personnalisés passent aussi par Tor quand il est activé. Les données de Tor (consensus, état des gardes) sont stockées dans le dossier de l'app (`tor/`).

Pourquoi l'onion : `mempool.space` ne répond pas aux relais de sortie Tor (délai dépassé à la sortie sur toutes nos tentatives, 30/10/2026) ; son service onion répond.

## Ce que chaque serveur voit

En mode clair, tout serveur contacté voit ton **adresse IP** ; en mode Tor (défaut), il voit celle d'un relais de sortie. Dans les deux modes, les nœuds blockchain voient les **adresses publiques** dont tu demandes le solde. Pour éviter ça : utilise **tes propres nœuds** (Réglages → Réseaux et serveurs).

| Hôte | Pourquoi | Données envoyées |
|---|---|---|
| `api.coingecko.com` (`pro-api.coingecko.com` avec clé) | Prix du top 250, variations, graphiques | Devise d'affichage, identifiants de cryptos. **Aucune adresse.** |
| `mempool.space` (mode clair) | Bitcoin : UTXO, historique, frais, diffusion des transactions | Tes adresses Bitcoin, tes transactions signées |
| `mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion` (mode Tor uniquement, `http://`) | Même service que `mempool.space`, via son service onion officiel | Tes adresses Bitcoin, tes transactions signées (jamais ton IP) |
| `litecoinspace.org` (`/api` mainnet, `/testnet/api` testnet4) | Litecoin : soldes, UTXO, historique, frais, transactions précédentes, diffusion — appelé **par Rust** (`ltc_*`) ; l'interface n'a pas à le joindre (il est dans l'allowlist comme `mempool.space`). Mode Tor : via un relais de sortie (pas de service onion : l'en-tête `Onion-Location` du site est un modèle non configuré, `__NGINX_MEMPOOL_ONION__`, vérifié le 30/10/2026) ; joignable par Tor, testé le 30/10/2026 | Tes adresses Litecoin (une par requête, le serveur peut les regrouper), les txid de tes pièces, tes transactions signées |
| `nile.trongrid.io` (testnet) / `api.trongrid.io` (mainnet) | TRON : dernier bloc (référence de la transaction que **Kyro construit lui-même**), compte et ressources (bande passante, énergie), paramètres de frais, simulation d'énergie d'un transfert TRC-20, solde USDT, historique (`/v1`), diffusion — appelés par Rust (`tron_*`) ; staking (`tron_stake_*`) : récompenses de vote (`getReward`), liste des SR (`listwitnesses`), part gardée par un SR (`getBrokerage`), prochain décompte (`getnextmaintenancetime`), délai de dégel (`getchainparameters`). Sans clé API (vérifié le 30/10/2026, quotas sans clé) ; clé optionnelle `KYRO_TRONGRID_API_KEY` / Réglages, envoyée en en-tête `TRON-PRO-API-KEY` à ces deux hôtes seulement : TronGrid relie alors tes requêtes à ton compte TronGrid. Via Tor : Nile répond ; mainnet a répondu, mais une fois **403** depuis un relais de sortie (TronGrid peut refuser certaines sorties Tor sans clé) : la requête échoue alors, sans repli | Ton adresse TRON, le destinataire et le montant des transferts que tu prépares (simulation d'énergie), les SR pour lesquels tu prépares un vote (`getBrokerage`), tes transactions signées |
| `s.altnet.rippletest.net:51234` (testnet, serveur public de Ripple) / `xrplcluster.com` (mainnet, cluster communautaire XRPL) | XRP Ledger : réseau et réserves (`server_info`), compte et compte destinataire (`account_info` : existence, drapeau « tag exigé »), frais et registre courant (`fee`), lignes de confiance, historique (`account_tx`), diffusion (`submit`), suivi (`tx`) — appelés par Rust (`xrp_*`). Sans clé. Via Tor : les deux répondent (testé le 30/10/2026, y compris le port 51234) | Ton adresse XRP, l'adresse du destinataire avant envoi, tes transactions signées |
| `preprod.koios.rest` (testnet preprod) / `api.koios.rest` (mainnet) | Cardano (Koios REST, offre publique gratuite **sans clé**) : réseau (`genesis` : `networkmagic`), dernier slot (`tip`), paramètres de protocole (`epoch_params`), UTxO de ton adresse (`address_utxos`), historique (`address_txs` + `tx_info`), suivi (`tx_status`), diffusion (`submittx`, CBOR brut) — appelés par Rust (`ada_*`) ; staking (`ada_stake_*`) : état de ta clé de staking (`account_info`), pools (`pool_list`, `pool_info`), DRep (`drep_info`), dépôt de clé (`epoch_params`), époque (`tip`, `genesis`) ; **Kyro construit la transaction lui-même**. Via Tor : les deux répondent (testé le 30/10/2026 : preprod en 2,9 s pour `genesis` + `tip`, mainnet aussi). Blockfrost n'est pas utilisé (Koios suffit ; il faudrait une clé). L'offre gratuite de Koios a un quota par IP : derrière un relais de sortie partagé, un `429` est possible ; la requête échoue alors, sans repli | Ton adresse Cardano (adresse de base : elle contient ta clé de staking, donc tout ton compte est lié), ton adresse de récompenses (`stake…`), les pools et DRep que tu consultes ou choisis, tes transactions signées |
| `ethereum-sepolia-rpc.publicnode.com` / `ethereum-rpc.publicnode.com` | Ethereum : soldes, nonce, gas, diffusion | Ton adresse EVM, tes transactions signées |
| `arbitrum-one-rpc`, `optimism-rpc`, `base-rpc`, `polygon-bor-rpc`, `bsc-rpc`, `avalanche-c-chain-rpc` `.publicnode.com` | Chaînes EVM (phase 2), mêmes usages | Ton adresse EVM, tes transactions signées |
| `cronos-evm-rpc`, `mantle-rpc`, `sonic-rpc`, `gnosis-rpc`, `hyperliquid-rpc`, `sei-evm-rpc` `.publicnode.com` ; `flare-api.flare.network` (Flare, RPC public de la Flare Foundation) ; `public-en.node.kaia.io` (Kaia, RPC public de la Kaia Foundation) ; `evm.confluxrpc.com` (Conflux eSpace, RPC public de Conflux) | Chaînes EVM (phase 2) : Cronos, Mantle, Sonic, Gnosis, HyperEVM, Sei, Flare, Kaia, Conflux eSpace ; mêmes usages. Vérifiés le 31/10/2026 en clair : `eth_chainId` attendu, transactions EIP-1559 acceptées, lots JSON-RPC (soldes de tokens) servis ; **pas encore testés via Tor** | Ton adresse EVM, tes transactions signées |
| `api.devnet.solana.com` / `api.mainnet-beta.solana.com` | Solana : solde, blockhash, diffusion ; lecture par Rust des tables d'adresses (ALT) d'une transaction v0 avant de l'afficher et de la signer ; staking (`sol_stake_*`, par Rust) : tes comptes de staking (`getProgramAccounts` du programme Stake filtré sur ton adresse), validateurs (`getVoteAccounts`, noms validator-info du programme Config), sysvar StakeHistory, époque, minimum de délégation, rent, `getLatestBlockhash`, `sendTransaction` | Ton adresse Solana, tes transactions signées, les adresses des tables utilisées par la transaction à signer, tes comptes de staking et le validateur choisi |
| `api.0x.org` | Devis de swap EVM (si clé configurée) | Tokens, montant, ton adresse (destinataire du swap) |
| `li.quest` | Devis de swap cross-chain | Tokens, montant, chaînes, ton adresse |
| `lite-api.jup.ag` | Devis de swap Solana | Tokens, montant, ton adresse |

Les devis de swap ne sont demandés que lorsque tu ouvres l'écran Swap et saisis un montant.

Le robinet du testnet XRPL (`faucet.altnet.rippletest.net`) n'est **pas** contacté par l'application : seul le test réel du dépôt l'utilise (financement d'une adresse de test).

Le robinet Cardano preprod (`faucet.preprod.world.dev.cardano.org`) n'est contacté **ni** par l'application **ni** par les tests : il est protégé par un reCAPTCHA Google, que Kyro ne contourne pas (financement d'une adresse de test : à la main, dans un navigateur).

### Dogecoin : pas de serveur par défaut

Kyro ne contacte **aucun** serveur Dogecoin tant que tu n'en as pas configuré un (Réglages → Réseaux, type Esplora, par exemple ton instance d'[electrs-dogecoin](https://github.com/dogecoin/dogecoin/discussions/3626)) : les commandes `doge_*` répondent `SERVER_INVALID`. Raison : au 30/10/2026, aucune API publique **gratuite, maintenue, avec un testnet et la diffusion** n'a été trouvée.

| Candidat vérifié le 30/10/2026 | Résultat |
|---|---|
| QED electrs (`doge-electrs-demo.qed.me`, `doge-electrs-testnet-demo.qed.me`, forme Esplora, mainnet + testnet) | HTTP 522 (origine injoignable derrière Cloudflare) en clair et via Tor, à plusieurs reprises |
| SoChain v3 (`sochain.com/api/v3`, `DOGETEST`) | lecture sans clé possible, mais **pas de diffusion** (`broadcast_transaction` retiré), forme non Esplora, quotas |
| BlockCypher (`api.blockcypher.com/v1/doge/main`) | mainnet seulement (pas de testnet Dogecoin), 100 requêtes/h sans clé |
| Blockchair | mainnet seulement, quotas |
| Blockbook de Trezor (`doge1.trezor.io`) | bloqué par Cloudflare pour les clients autres que Trezor |
| NOWNodes, Tatum, QuickNode (Blockbook) | testnet disponible mais **clé API payante** |

Options : héberger electrs-dogecoin (avec un nœud Dogecoin Core) et l'entrer comme serveur Esplora ; ajouter QED comme défaut s'il redevient joignable (une ligne dans `servers.rs` + cette page + l'allowlist) ; écrire un adaptateur Blockbook (forme différente) pour un fournisseur à clé.

Les tables d'adresses (ALT) d'une transaction Solana v0 sont lues par Rust auprès du RPC Solana (celui des réglages, sinon le RPC par défaut ci-dessus), jamais transmises par l'interface. Kyro fait confiance à ce RPC pour leur contenu, comme pour les soldes ; une table introuvable, désactivée ou incomplète bloque l'aperçu et la signature.

## Serveurs personnalisés (Réglages → Réseaux)

Tu peux remplacer le serveur par défaut de chaque chaîne : Bitcoin (Esplora, Electrum ou ton nœud Bitcoin Core), Litecoin et Dogecoin (Esplora, le même type que le défaut), TRON (API HTTP java-tron, comme TronGrid ; l'historique exige l'API `/v1` de TronGrid : avec un nœud seul, il est refusé avec un message clair), XRP Ledger (JSON-RPC rippled), Cardano (instance Koios), chaque chaîne EVM, chaque cluster Solana. Règles communes :
- un serveur personnalisé n'est autorisé **que pour sa propre famille** et passe par les **circuits Tor isolés** de cette famille ;
- il est vérifié à l'enregistrement : il doit être sur le bon réseau (genesis Bitcoin, Litecoin, Dogecoin ou TRON, `network_id` XRPL, `networkmagic` Cardano, `eth_chainId`, genesis Solana), sinon il est refusé ;
- dès qu'il est configuré, le serveur par défaut de cette chaîne est **refusé** : si ton serveur tombe, Kyro affiche une erreur (`SERVER_UNREACHABLE`) et **ne se rabat jamais** sur le serveur par défaut — sinon tes adresses partiraient chez le tiers que tu as justement voulu éviter ;
- jamais d'identifiants dans une URL ; `http://` en clair n'est permis que pour une adresse `.onion` via Tor (le protocole onion authentifie le service et chiffre de bout en bout) et, pour Bitcoin Core seulement, pour une adresse locale.

| Serveur | Mode Tor (défaut) : ce que le serveur voit | Mode clair : ce que le serveur voit | Ne voit jamais |
|---|---|---|---|
| mempool.space (défaut Bitcoin) | Ton adresse Bitcoin et tes transactions, via son service **.onion** : aucun relais de sortie, aucune IP | Tes adresses, tes transactions **et ton IP** | Ta phrase, tes clés |
| Esplora personnalisé (`https://` ou `.onion`) | Tes adresses et transactions ; l'IP d'un relais de sortie (ou aucune si `.onion`) | Tes adresses, transactions et ton IP ; `.onion` refusé | Ta phrase, tes clés |
| Electrum (TLS, ou TCP vers un `.onion`) | Tes *script hashes* (équivalent de tes adresses), tes transactions ; l'IP d'un relais de sortie (aucune si `.onion`) | Idem **et ton IP** ; `.onion` refusé | Ta phrase, tes clés |
| Bitcoin Core **local/LAN** (127.0.0.0/8, ::1, RFC 1918, fc00::/7) | Joint **directement, sans Tor** (Tor ne peut pas atteindre ton réseau local, et rien ne sort de ta machine/ton réseau) : ton propre nœud voit tes descripteurs publics (xpub) et tes transactions | Idem | Ta phrase, tes clés privées (portefeuille de surveillance sans clé privée) |
| Bitcoin Core **distant** (`https://` ou `.onion`) | Tes descripteurs publics (xpub : **tout l'historique de ton compte**, présent et futur), tes transactions ; l'IP d'un relais de sortie (aucune si `.onion`) | Idem **et ton IP** ; `.onion` refusé | Ta phrase, tes clés privées |
| litecoinspace.org (défaut Litecoin) | Tes adresses Litecoin, les txid de tes pièces, tes transactions ; l'IP d'un relais de sortie | Idem **et ton IP** | Ta phrase, tes clés |
| Esplora Litecoin / Dogecoin personnalisé (`https://` ou `.onion`) | Tes adresses, les txid de tes pièces (Dogecoin : chaque transaction précédente que tu dépenses), tes transactions ; l'IP d'un relais de sortie (aucune si `.onion`) | Idem **et ton IP** ; `.onion` refusé | Ta phrase, tes clés |
| TronGrid (défaut TRON) / nœud java-tron personnalisé | Ton adresse TRON, tes soldes et ressources, le destinataire et le montant simulés, tes transactions signées ; l'IP d'un relais de sortie (aucune si `.onion`) | Idem **et ton IP** | Ta phrase, tes clés |
| Serveur XRPL par défaut / rippled personnalisé | Ton adresse XRP, l'adresse des destinataires, tes transactions signées ; l'IP d'un relais de sortie (aucune si `.onion`) | Idem **et ton IP** | Ta phrase, tes clés |
| Koios par défaut / Koios personnalisé (Cardano) | Ton adresse Cardano (et donc ta clé de staking), tes transactions signées ; l'IP d'un relais de sortie (aucune si `.onion`) | Idem **et ton IP** | Ta phrase, tes clés |
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
