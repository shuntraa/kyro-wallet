# Frais Kyro sur les swaps

Kyro prend **0,7 % (70 bps)** sur chaque swap. Ces frais servent à financer le projet. Kyro étant open source, ils sont publics : n'importe qui peut lire le code, les modifier, les passer à 0 ou les retirer dans sa propre version.

- **Configuration** : un seul fichier, [`packages/swap/src/fees.ts`](../packages/swap/src/fees.ts) (`KYRO_SWAP_FEE`).
- **Affichage** : l'écran Swap ne montre que ce que tu donnes et ce que tu reçois, déjà net de tous les frais. La confirmation, avant ton mot de passe, montre une seule ligne « Frais inclus ≈ … » : le total des frais Kyro et du fournisseur, sans détail par fournisseur.
- **Collecte** : les frais sont prélevés sur la blockchain par le **mécanisme officiel « intégrateur »** de chaque fournisseur. Kyro n'ajoute jamais de transfert supplémentaire.
- **Plafond** : 1 % (`MAX_FEE_BPS`). Au-delà, la configuration est refusée.

## Règle : chaque swap porte les frais

Si un fournisseur ne peut pas encaisser les frais avec la configuration actuelle, il est **écarté des devis**. La raison est donnée, et Kyro ne l'utilise jamais sans frais en douce. Kyro n'envoie pas non plus de frais à une adresse qu'il ne peut pas valider. Le choix du meilleur prix se fait **après frais** : chaque fournisseur déduit les frais du montant qu'il annonce, et les devis sont comparés sur ce montant net.

## Par fournisseur

Les paramètres ci-dessous ont été vérifiés dans la documentation officielle le 31/10/2026.

| Fournisseur | Paramètres envoyés | Qui reçoit | Prélevé sur | Contrôle par Kyro |
|---|---|---|---|---|
| **0x** (Swap API v2) | `swapFeeRecipient`, `swapFeeBps=70`, `swapFeeToken=<jeton vendu>` | `recipients.evm`, payé dans la transaction | le jeton vendu | le devis doit renvoyer `fees.integratorFee`, sinon il est refusé |
| **LI.FI** | `distributionFees[0][receiver]`, `distributionFees[0][percentage]=0.007` (**en fraction**) | ton adresse **sur la chaîne de départ** : `recipients.evm` (départ EVM) ou `recipients.solana` (départ Solana), versé directement (aucune inscription) | le jeton envoyé, sur la chaîne de départ (`included` → déjà déduit de `toAmount`) | le devis doit renvoyer une ligne « Distributions » à 0,7 % vers cette adresse, sinon il est refusé |
| **Jupiter** (Metis `swap/v1`) | `platformFeeBps=70` sur `/quote`, `feeAccount` sur `/swap` | le compte de jetons associé (ATA) de `recipients.solana` | **USDC** pour l'instant (`solanaFeeMints`) : le jeton de sortie s'il est en USDC, sinon le jeton d'entrée | le devis doit renvoyer `platformFee.feeBps = 70`, sinon il est refusé |
| **NEAR Intents 1Click** (en direct, `POST /v0/quote`) | `appFees: [{ recipient: "0x86cd…8b44", fee: 140 }]` | le **compte NEAR Intents** `0x86cd9af8067ff5e0001c709a550cd62b5e968b44` (= `recipients.evm` en minuscules ; compte du registre `intents.near` contrôlé par la clé de cette adresse EVM) | le jeton **déposé** (vendu), retenu par 1Click sur le dépôt et crédité à ce compte | 1Click partage la commission demandée **50/50** avec lui-même (vrais devis du 01/11/2026 : `fee: 140` → 70 pour Kyro + 70 pour le compte 1Click `5880ad…47dd`). Kyro demande donc 140 et exige dans la réponse du devis **et** dans `/v0/status` de l'adresse de dépôt : **exactement 70 bps** vers ce compte, une seule fois, et **au plus 70 bps** pour 1Click ; sinon refus. Si 1Click partage autrement (sa doc décrit aussi « ta commission + 25 bps » sans clé API), Kyro redemande une fois le montant qui donne exactement 70, puis revérifie |

### Par route (où et dans quel jeton)

| Route | Fournisseur | Frais Kyro prélevés | Versés à |
|---|---|---|---|
| Même chaîne EVM (Ethereum, Arbitrum, Optimism, Base, Polygon, BNB Chain, Avalanche) | 0x ou LI.FI | dans le jeton **vendu**, sur cette chaîne | `recipients.evm` (`0x86cD…8B44`) |
| Même chaîne Solana | Jupiter | en **USDC** (jeton de sortie s'il est en USDC, sinon d'entrée) | compte USDC de `recipients.solana` (`CFPW…Qx7C`) |
| EVM → autre chaîne EVM, EVM → Solana, EVM → Bitcoin | LI.FI (pont NEAR Intents) | dans le jeton **envoyé**, sur la chaîne EVM de départ (étape FeeForwarder) | `recipients.evm` |
| Solana → EVM, Solana → Bitcoin | LI.FI (pont NEAR Intents) | dans le jeton **envoyé**, sur Solana : SOL par un transfert System, un jeton SPL par un `TransferChecked` vers le compte de ce jeton de `recipients.solana` | `recipients.solana` (`ptsb…BZcM`) ou son compte du jeton |
| Bitcoin → EVM / Solana / Litecoin / Dogecoin / TRON / XRP / Cardano | NEAR Intents 1Click (direct) | en **BTC**, retenus par 1Click sur le dépôt | compte NEAR Intents `0x86cd…8b44` |
| Litecoin → toute chaîne servie | NEAR Intents 1Click (direct) | en **LTC**, sur le dépôt | compte NEAR Intents `0x86cd…8b44` |
| Dogecoin → toute chaîne servie | NEAR Intents 1Click (direct) | en **DOGE**, sur le dépôt | compte NEAR Intents `0x86cd…8b44` |
| TRON → toute chaîne servie (TRX ⇄ USDT sur TRON compris) | NEAR Intents 1Click (direct) | en **TRX** ou en **USDT TRC-20**, sur le dépôt | compte NEAR Intents `0x86cd…8b44` |
| XRP → toute chaîne servie | NEAR Intents 1Click (direct) | en **XRP**, sur le dépôt | compte NEAR Intents `0x86cd…8b44` |
| Cardano (ADA seul) → toute chaîne servie | NEAR Intents 1Click (direct) | en **ADA**, sur le dépôt | compte NEAR Intents `0x86cd…8b44` |
| EVM / Solana → Litecoin, Dogecoin, TRON, XRP, Cardano | NEAR Intents 1Click (direct) | dans le jeton **envoyé** (ETH, USDC, SOL…), sur le dépôt | compte NEAR Intents `0x86cd…8b44` |

« Toute chaîne servie » : les chaînes EVM servies par 1Click (Ethereum, Arbitrum, Optimism, Base, Polygon, BNB Chain, Avalanche), Solana, Bitcoin, Litecoin, Dogecoin, TRON, XRP et Cardano ; l'arrivée est toujours **ton propre compte** Kyro sur cette chaîne. Les frais NEAR Intents ne vont **pas** à `recipients.bitcoin`, `recipients.tron`… : 1Click ne paie les commissions d'intégrateur qu'à un compte NEAR Intents. Le propriétaire les retire depuis ce compte avec la clé de `0x86cD…8B44` (par exemple sur near-intents.org, en se connectant avec ce portefeuille EVM), dans le jeton où elles ont été prélevées.

Vérifié par de vrais devis 1Click (lecture seule, aucun dépôt) le 01/11/2026 : BTC → ETH, LTC → SOL, DOGE → BTC, TRX → ETH, USDT TRC-20 → USDC Solana, XRP → SOL, ADA → ETH, ETH Arbitrum → LTC ; à chaque fois `appFees` renvoie 70 vers `0x86cd…8b44` et 70 vers 1Click, dépôt `SIMPLE` sans mémo, et `/v0/status` de l'adresse de dépôt répète les mêmes conditions. 1Click impose temporairement un minimum de **100 $** au départ de TRON.

Vérifié par de vrais devis li.quest (lecture seule) le 01/11/2026 : Arbitrum USDC → SOL, Base ETH → USDC Solana, Arbitrum USDC → BTC (frais en USDC ou ETH vers `0x86cD…`) ; SOL → ETH Arbitrum et USDC Solana → USDC Base (frais en SOL / USDC vers `ptsb…` ou `CFPW…`). li.quest refuse un bénéficiaire EVM pour un départ Solana (« not a valid Solana address for chain 1151111081099710 ») : le bénéficiaire suit la chaîne de départ.

Pour un départ Solana avec un jeton SPL autre que l'USDC, le portefeuille de frais doit posséder le compte de ce jeton ; sinon la transaction de LI.FI le crée (loyer ≈ 0,002 SOL payé par l'utilisateur) ou échoue. Kyro accepte la création d'un compte du jeton vendu, payée par toi, et l'affiche dans les frais réseau.

Sources :
- 0x : [Monetize your app using Swap](https://docs.0x.org/evm/0x-swap-api/guides/monetize-your-app-using-swap.md)
- LI.FI : [Monetizing the integration](https://docs.li.fi/introduction/integrating-lifi/monetizing-integration)
- Jupiter : [Add fees to swap](https://developers.jup.ag/docs/swap-api/add-fees-to-swap)
- NEAR Intents : [Fee Configuration](https://docs.near-intents.org/integration/distribution-channels/1click-api/fee-config) et [Fees](https://docs.near-intents.org/resources/fees) (`appFees`, `recipient` = « Any NEAR-supported address (… or EVM-like address) », prélevé sur le jeton d'entrée, total ≤ 500 bps)

## Ce que Kyro vérifie dans chaque devis

Les paramètres envoyés ne suffisent pas : un fournisseur pourrait renvoyer une transaction qui ne les respecte pas. Kyro décode donc la transaction **avant** de l'afficher, et de nouveau juste avant de signer (code : [`packages/swap/src/verify.ts`](../packages/swap/src/verify.ts), [`jupiter-verify.ts`](../packages/swap/src/jupiter-verify.ts)).

| Fournisseur | Frais Kyro contrôlés | Autres contrôles |
|---|---|---|
| **0x** | `fees.integratorFee` présent, pris dans le jeton vendu, **montant ≤ montant vendu × 70 / 10 000** ; l'adresse de frais doit figurer dans la transaction. Le détail de l'action Settler qui paie les frais n'est pas décodé. | `to` et autorisation = AllowanceHolder `0x0000000000001fF3684f28c67538d4D072C22734` ; Settler appelé = celui du registre `0x00000000000004533Fe15556B1E086BB1A72cEae` (`ownerOf(2)` ou `prev(2)`) ; destinataire = toi, minimum ≥ annoncé − slippage. |
| **LI.FI** (même chaîne) | Étape `FeeForwarder` (`0xCE40449B773a3E6E5e769ADb4e567179d4828cbd`) décodée : un versement à `recipients.evm`, **≤ montant vendu × 70 / 10 000** ; total des frais de cette étape ≤ 0,7 % + 0,5 % (part de LI.FI comprise). | `to` et autorisation = Diamond `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` ; `_receiver` = toi, `_minAmountOut` ≥ annoncé − slippage ; première et dernière étapes = jetons et montant de la paire. |
| **LI.FI entre chaînes, départ EVM** | Même étape `FeeForwarder`, dans le jeton envoyé. | Pont **NEAR Intents seul** (`allowBridges=near`) ; appel `swapAndStartBridgeTokensViaNEARIntents` (facette `NEARIntentsFacet`) décodé : chaîne d'arrivée, `BridgeData.receiver` = toi (EVM) ou `0x11f1…11F1` avec `nonEVMReceiver` = ta clé Solana / les 32 mots de ton adresse `bc1q`, pas d'appel à l'arrivée, remboursement vers toi, `minAmountOut` ≥ annoncé − slippage, token d'arrivée, étapes de départ cohérentes. Puis **NEAR Intents confirme l'adresse de dépôt** (`1click.chaindefuser.com/v0/status`) : destinataire = ton compte, remboursement vers toi, montant déposé, token et minimum. |
| **LI.FI entre chaînes, départ Solana** | Transfert vers `recipients.solana` (SOL) ou son compte du jeton (SPL), **> 0 et ≤ montant vendu × 70 / 10 000**. | Transaction décodée par Rust, puis seuls sont acceptés : budget de calcul (priorité ≤ 0,01 SOL), une instruction de suivi LI.FI (`3i5JeuZuUxeKtVysUnwQNGerJP2bSMX9fTFfS4Nxe3Br`, qui ne déplace rien), des transferts **depuis ton compte du jeton vendu** vers les frais Kyro, les frais LI.FI (`34FKjAdVcTax2DHqV2XnbXa9J3zmyKcFuFKWbcmgxjgm`, ≤ 0,5 %) et **une** adresse de dépôt ; total = montant vendu exactement. Puis même confirmation par NEAR Intents. |
| **NEAR Intents 1Click (direct)** | `appFees` renvoyé par 1Click, dans le devis puis dans `/v0/status` de l'adresse de dépôt : **exactement** 70 bps vers `0x86cd…8b44`, une seule entrée, part de 1Click ≤ 70 bps. | Aucune transaction tierce : 1Click donne une **adresse de dépôt à usage unique** liée (devis signé) à ton compte d'arrivée et à ton adresse de remboursement. Kyro exige `EXACT_INPUT`, dépôt `SIMPLE` (**pas de mémo, pas d'OP_RETURN, pas de tag**), destinataire = ton compte (`DESTINATION_CHAIN`), remboursement = ton adresse de départ (`ORIGIN_CHAIN`), montant = ta saisie, jetons demandés, minimum ≥ annoncé − slippage, adresse de dépôt ≠ la tienne, statut `PENDING_DEPOSIT` et au moins 2 h avant l'échéance (la plus proche entre celle de 1Click et les 3 h demandées par Kyro). Puis Kyro construit **lui-même** un envoi ordinaire de ce montant vers cette adresse avec l'adaptateur de la chaîne, et le contrôle (`depositTxProblem`) : un seul paiement vers l'adresse de dépôt (BTC/LTC/DOGE : le reste en monnaie, aucune sortie OP_RETURN ou script inconnu ; TRON : simple transfert TRX ou TRC-20 du bon contrat, sans mémo ; XRP : sans tag, mémo ni chemin, et refus si l'adresse exige un tag ; Cardano : ADA seul, sans message ; EVM / Solana : décodage Rust identique). 1Click est relu **juste avant de signer**. |
| **Jupiter** | `platform_fee_bps` = 70 et compte de frais = le compte attendu de `recipients.solana` (lus dans l'instruction de route). | Payeur et seul signataire = toi ; programmes autorisés seulement (budget de calcul, ATA, emballage SOL, une route Jupiter v6) ; comptes débité et crédité à toi ; montant et slippage ; frais de priorité ≤ 0,01 SOL. |

Adresses relevées dans les dépôts officiels (0x : docs.0x.org et 0x-settler ; LI.FI : `lifinance/contracts`, `deployments/<chaîne>.json`) le 01/11/2026, identiques sur Ethereum, Arbitrum, Optimism, Base, Polygon, BNB Chain et Avalanche. Sur un autre réseau (testnet compris), aucun contrat n'est connu : les devis 0x et LI.FI sont refusés.

## Ce qu'il faut configurer avant d'encaisser

Tant que ces réglages manquent, les fournisseurs concernés sont écartés, et aucun swap ne part sans frais.

1. **`recipients.evm`** : ton adresse EVM. Elle reçoit les frais de 0x et de LI.FI sur toutes les chaînes EVM.
2. **`recipients.solana`** : ton adresse Solana, **le portefeuille lui-même, pas un compte de jetons**. Il doit posséder un **compte de jetons initialisé** pour chaque mint de `solanaFeeMints`, sinon la transaction Jupiter échoue.
   - Pour l'instant, c'est **USDC seul**. Le compte USDC de l'adresse configurée a été vérifié sur le réseau principal le 31/10/2026 : `CFPWYSxLRh79CobY4gLWzh15zgRgEgo2Cqb4e7gBQx7C`.
   - Jupiter ne peut prendre les frais que dans un des deux jetons du swap. Une paire Solana **sans USDC** (par exemple SOL → BONK) ne peut donc pas porter les frais, et Jupiter ne fait pas de devis pour elle.
   - Pour accepter aussi le SOL : crée le compte wSOL du portefeuille de frais (enveloppe un peu de SOL), puis ajoute le mint wSOL à `solanaFeeMints`.
3. **LI.FI** : rien à faire. Kyro utilise `distributionFees`, qui verse les frais directement à `recipients.evm`, sans inscription sur portal.li.fi. Vérifié par un vrai devis le 31/10/2026 (Arbitrum, USDC → ETH) : LI.FI renvoie « Distributions 0,7 % » vers l'adresse configurée. À l'inverse, un nom d'intégrateur non enregistré est refusé par LI.FI (`code 1011`). Au départ de Solana, les frais vont à `recipients.solana` (SOL) ou à son compte du jeton vendu (vérifié le 01/11/2026 : SOL → ETH Arbitrum et USDC → USDC Base).
4. **NEAR Intents** : rien à faire pour encaisser. Les frais s'accumulent sur le compte NEAR Intents `0x86cd9af8067ff5e0001c709a550cd62b5e968b44` (pas d'inscription, pas de clé API). Pour les récupérer, il faut **retirer** depuis ce compte avec la clé de `recipients.evm` (le compte n'existe que dans le registre `intents.near`, chaque jeton y reste tant qu'il n'est pas retiré). Changer `recipients.evm` change aussi ce compte.
5. **THORName** (`thorname`) : vide. THORChain n'est **pas** utilisé (décision du propriétaire) ; ce serait un dernier recours.

## Autres chaînes : ce qui passe par NEAR Intents, ce qui reste fermé

`fees.ts` contient aussi tes adresses Bitcoin (`bc1qta8e…aard`), Litecoin (`LWeP…vNyw`), Dogecoin (`DKCS…AU14`), TRON (`TT9j…51pES`), XRP (`rBxj…mSZf`, sans tag) et Cardano (`addr1qy9d…dj3`), chacune vérifiée au chargement (format et somme de contrôle ; une adresse fausse écarte la route, jamais de swap sans frais). **Elles ne reçoivent aucun frais aujourd'hui** : aucun mécanisme officiel ne verse une commission d'intégrateur à une adresse de ces chaînes. Les départs de ces chaînes passent par **NEAR Intents 1Click**, qui paie la commission (dans le jeton déposé) au compte NEAR Intents de `recipients.evm` (voir « Par route »).

Pourquoi pas un autre fournisseur :

- **LI.FI** : `distributionFees` n'est pas pris en charge au départ de Bitcoin (« distributionFees not supported on chain 20000000000001 », vrai devis du 01/11/2026). Litecoin, Dogecoin, XRP et Cardano ne sont pas des chaînes LI.FI. Au départ de TRON, LI.FI accepte les frais mais **exige un bénéficiaire au format EVM** (« not a valid EVM address for chain 728126428 ») : les frais (en USDT) iraient à l'adresse TRON de la clé de `0x86cD…`, pas à `TT9j…`. Non activé (NEAR Intents couvre TRON).
- **THORChain** : écarté par le propriétaire. Ses frais d'affilié vont à un **THORName** ; ce serait un dernier recours si NEAR Intents cessait de servir une chaîne.

Limites des routes NEAR Intents :

- **Cardano** : ADA seulement (1Click ne liste pas les jetons natifs Cardano).
- **XRP** : XRP seulement (pas de jetons émis) ; refus si l'adresse de dépôt exige un tag.
- **Minimums** de 1Click (par exemple 100 $ au départ de TRON au 01/11/2026) : en dessous, pas de devis.
- **Coût pour l'utilisateur** : 0,7 % Kyro **plus** 0,7 % pour 1Click (sa moitié du partage), soit 1,4 % retenus sur le dépôt, comptés ensemble dans « Frais inclus » de la confirmation.

## 1inch : retiré

1inch ne verse les frais partenaires que sur une **offre payante** : sur l'offre gratuite, il reçoit `fee` et `referrer` mais les ignore sans erreur, si bien que le swap passerait sans commission. Comme il n'existe pas d'autre mécanisme officiel, et que Kyro n'ajoute jamais de transfert lui-même, 1inch a été retiré (fournisseur, clé API, hôte `api.1inch.dev` de l'allowlist). 0x et LI.FI couvrent l'EVM.

## Ce que les fournisseurs prennent eux-mêmes

Ce sont les frais propres à chaque fournisseur, en plus de ceux de Kyro et sans aucun lien avec eux. Ils sont déjà compris dans le prix annoncé ou dans les frais réseau affichés.

- **0x** : 0,15 % sur certaines paires (offre Standard), renvoyés dans `fees.zeroExFee`. Le gain de slippage positif revient à 0x, sauf sur offre personnalisée.
- **LI.FI** : 0,25 % de frais de service, prélevés en plus de la commission Kyro.
- **Jupiter (Metis)** : aucune part des frais de plateforme annoncée.
- **NEAR Intents 1Click** : sa moitié des `appFees` (0,7 % aujourd'hui, renvoyée dans le devis et comptée dans « Frais inclus »), plus le protocole (0,0001 %) ; si le swap est exécuté à un meilleur prix que le devis, l'écart est partagé avec 1Click. En cas de remboursement, 1Click retient `refundFee` (frais réseau du renvoi).

## Non vérifié à ce jour

- **Aucun swap réel n'a été envoyé** : tout est testé contre des réponses simulées, plus de vraies réponses li.quest (deux sur une même chaîne, cinq entre chaînes avec le statut 1Click de leur dépôt), huit vrais devis 1Click en direct avec le statut de leur adresse de dépôt, et deux vraies transactions Jupiter (01/11/2026, non signés) que le décodeur accepte tels quels. Les agrégateurs et les ponts ne fonctionnent pas sur testnet.
- **NEAR Intents en direct** : le versement effectif de la commission au compte `0x86cd…8b44` n'a pas été observé (il faudrait un vrai dépôt) ; Kyro vérifie seulement ce que 1Click s'engage à faire dans son devis signé et son statut. Le partage 50/50 sans clé API est observé en direct, alors que la doc décrit « commission + 25 bps » sans clé : Kyro s'adapte (une seule nouvelle demande) mais n'accepte jamais une part différente de 0,7 %. La signature ed25519 des devis 1Click n'est pas vérifiée par Kyro (la réponse arrive en HTTPS de l'hôte allowlisté et est relue par `/v0/status`).
- **Entre chaînes** : la livraison à l'arrivée dépend du réseau de solveurs de NEAR Intents (remboursement sur l'adresse de départ s'il échoue). Kyro vérifie ce qui est signé et ce que le pont s'engage à faire, pas la livraison. LI.FI applique le slippage à **chaque** étape (swap de départ puis pont) : Kyro demande la moitié du slippage choisi par étape, puis exige que le minimum du pont respecte le slippage choisi. L'adresse du portefeuille de frais LI.FI sur Solana (`34FK…xjgm`) n'est pas documentée par LI.FI : relevée dans les vraies transactions ; si elle change, les départs Solana sont refusés jusqu'à mise à jour.
- **0x** : le décodage n'a pas été confronté à une vraie réponse (clé API nécessaire) ; il suit les interfaces publiées (`IAllowanceHolder.exec`, `ISettlerTakerSubmitted.execute`). Une vente de jeton natif dont `transaction.to` ne serait pas AllowanceHolder est refusée (comportement non documenté par 0x), tout comme un échange ETH ⇄ WETH (adressé directement au contrat WETH).
- **0x** : la documentation ne dit pas noir sur blanc si `buyAmount` est déjà net des frais intégrateur. Kyro prélève les frais sur le jeton vendu : le montant annoncé correspond à ce qui est réellement échangé.
- **Jupiter** : la doc de Metis le déclare désormais « plus maintenu », remplacé par Swap V2 (`api.jup.ag/swap/v2`), et `lite-api.jup.ag` est retiré petit à petit. Migrer change d'hôte, donc il faudra mettre à jour en même temps l'allowlist, `NETWORK.md` et `IPC.md`.
