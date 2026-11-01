# Frais Kyro sur les swaps

Kyro prend **0,7 % (70 bps)** sur chaque swap. Ces frais servent à financer le projet. Kyro étant open source, ils sont publics : n'importe qui peut lire le code, les modifier, les passer à 0 ou les retirer dans sa propre version.

- **Configuration** : un seul fichier, [`packages/swap/src/fees.ts`](../packages/swap/src/fees.ts) (`KYRO_SWAP_FEE`).
- **Affichage** : le montant est montré avant chaque swap (« Frais Kyro 0,7 % »), puis rappelé dans la confirmation avant signature.
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

### Par route (où et dans quel jeton)

| Route | Fournisseur | Frais Kyro prélevés | Versés à |
|---|---|---|---|
| Même chaîne EVM (Ethereum, Arbitrum, Optimism, Base, Polygon, BNB Chain, Avalanche) | 0x ou LI.FI | dans le jeton **vendu**, sur cette chaîne | `recipients.evm` (`0x86cD…8B44`) |
| Même chaîne Solana | Jupiter | en **USDC** (jeton de sortie s'il est en USDC, sinon d'entrée) | compte USDC de `recipients.solana` (`CFPW…Qx7C`) |
| EVM → autre chaîne EVM, EVM → Solana, EVM → Bitcoin | LI.FI (pont NEAR Intents) | dans le jeton **envoyé**, sur la chaîne EVM de départ (étape FeeForwarder) | `recipients.evm` |
| Solana → EVM, Solana → Bitcoin | LI.FI (pont NEAR Intents) | dans le jeton **envoyé**, sur Solana : SOL par un transfert System, un jeton SPL par un `TransferChecked` vers le compte de ce jeton de `recipients.solana` | `recipients.solana` (`ptsb…BZcM`) ou son compte du jeton |
| Départ Bitcoin, Litecoin, Dogecoin, TRON, XRP, Cardano | — | **aucune route** : voir « Autres chaînes » plus bas | — |

Vérifié par de vrais devis li.quest (lecture seule) le 01/11/2026 : Arbitrum USDC → SOL, Base ETH → USDC Solana, Arbitrum USDC → BTC (frais en USDC ou ETH vers `0x86cD…`) ; SOL → ETH Arbitrum et USDC Solana → USDC Base (frais en SOL / USDC vers `ptsb…` ou `CFPW…`). li.quest refuse un bénéficiaire EVM pour un départ Solana (« not a valid Solana address for chain 1151111081099710 ») : le bénéficiaire suit la chaîne de départ.

Pour un départ Solana avec un jeton SPL autre que l'USDC, le portefeuille de frais doit posséder le compte de ce jeton ; sinon la transaction de LI.FI le crée (loyer ≈ 0,002 SOL payé par l'utilisateur) ou échoue. Kyro accepte la création d'un compte du jeton vendu, payée par toi, et l'affiche dans les frais réseau.

Sources :
- 0x : [Monetize your app using Swap](https://docs.0x.org/evm/0x-swap-api/guides/monetize-your-app-using-swap.md)
- LI.FI : [Monetizing the integration](https://docs.li.fi/introduction/integrating-lifi/monetizing-integration)
- Jupiter : [Add fees to swap](https://developers.jup.ag/docs/swap-api/add-fees-to-swap)

## Ce que Kyro vérifie dans chaque devis

Les paramètres envoyés ne suffisent pas : un fournisseur pourrait renvoyer une transaction qui ne les respecte pas. Kyro décode donc la transaction **avant** de l'afficher, et de nouveau juste avant de signer (code : [`packages/swap/src/verify.ts`](../packages/swap/src/verify.ts), [`jupiter-verify.ts`](../packages/swap/src/jupiter-verify.ts)).

| Fournisseur | Frais Kyro contrôlés | Autres contrôles |
|---|---|---|
| **0x** | `fees.integratorFee` présent, pris dans le jeton vendu, **montant ≤ montant vendu × 70 / 10 000** ; l'adresse de frais doit figurer dans la transaction. Le détail de l'action Settler qui paie les frais n'est pas décodé. | `to` et autorisation = AllowanceHolder `0x0000000000001fF3684f28c67538d4D072C22734` ; Settler appelé = celui du registre `0x00000000000004533Fe15556B1E086BB1A72cEae` (`ownerOf(2)` ou `prev(2)`) ; destinataire = toi, minimum ≥ annoncé − slippage. |
| **LI.FI** (même chaîne) | Étape `FeeForwarder` (`0xCE40449B773a3E6E5e769ADb4e567179d4828cbd`) décodée : un versement à `recipients.evm`, **≤ montant vendu × 70 / 10 000** ; total des frais de cette étape ≤ 0,7 % + 0,5 % (part de LI.FI comprise). | `to` et autorisation = Diamond `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` ; `_receiver` = toi, `_minAmountOut` ≥ annoncé − slippage ; première et dernière étapes = jetons et montant de la paire. |
| **LI.FI entre chaînes, départ EVM** | Même étape `FeeForwarder`, dans le jeton envoyé. | Pont **NEAR Intents seul** (`allowBridges=near`) ; appel `swapAndStartBridgeTokensViaNEARIntents` (facette `NEARIntentsFacet`) décodé : chaîne d'arrivée, `BridgeData.receiver` = toi (EVM) ou `0x11f1…11F1` avec `nonEVMReceiver` = ta clé Solana / les 32 mots de ton adresse `bc1q`, pas d'appel à l'arrivée, remboursement vers toi, `minAmountOut` ≥ annoncé − slippage, token d'arrivée, étapes de départ cohérentes. Puis **NEAR Intents confirme l'adresse de dépôt** (`1click.chaindefuser.com/v0/status`) : destinataire = ton compte, remboursement vers toi, montant déposé, token et minimum. |
| **LI.FI entre chaînes, départ Solana** | Transfert vers `recipients.solana` (SOL) ou son compte du jeton (SPL), **> 0 et ≤ montant vendu × 70 / 10 000**. | Transaction décodée par Rust, puis seuls sont acceptés : budget de calcul (priorité ≤ 0,01 SOL), une instruction de suivi LI.FI (`3i5JeuZuUxeKtVysUnwQNGerJP2bSMX9fTFfS4Nxe3Br`, qui ne déplace rien), des transferts **depuis ton compte du jeton vendu** vers les frais Kyro, les frais LI.FI (`34FKjAdVcTax2DHqV2XnbXa9J3zmyKcFuFKWbcmgxjgm`, ≤ 0,5 %) et **une** adresse de dépôt ; total = montant vendu exactement. Puis même confirmation par NEAR Intents. |
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
4. **THORName** (`thorname`) : vide. À enregistrer seulement si l'on veut ajouter THORChain (départs BTC, LTC, DOGE…).

## Autres chaînes : adresses prêtes, aucune route pour l'instant

`fees.ts` contient aussi tes adresses Bitcoin (`bc1qta8e…aard`), Litecoin (`LWeP…vNyw`), Dogecoin (`DKCS…AU14`), TRON (`TT9j…51pES`), XRP (`rBxj…mSZf`, sans tag) et Cardano (`addr1qy9d…dj3`), chacune vérifiée au chargement (format et somme de contrôle ; une adresse fausse écarte la route, jamais de swap sans frais). **Aucune n'est utilisée aujourd'hui**, parce qu'aucun mécanisme officiel ne verse de frais intégrateur à une adresse de ces chaînes :

- **LI.FI** : `distributionFees` n'est pas pris en charge au départ de Bitcoin (« distributionFees not supported on chain 20000000000001 », vrai devis du 01/11/2026). Litecoin, Dogecoin, XRP et Cardano ne sont pas des chaînes LI.FI. Au départ de TRON, LI.FI accepte les frais mais **exige un bénéficiaire au format EVM** (« not a valid EVM address for chain 728126428 ») : les frais (en USDT) iraient à l'adresse TRON de la clé de `0x86cD…` (même clé secp256k1, préfixe `41`), pas à `TT9j…`. Non activé : à décider (il faudrait pouvoir dépenser depuis cette adresse TRON).
- **THORChain** (BTC, LTC, DOGE, BCH, ETH, BSC, AVAX…) : les frais d'affilié (`affiliate` + `affiliate_bps` dans le mémo) sont versés à un **THORName** ou une adresse `thor1…`, pas sur la chaîne de départ. `thorname` est vide dans `fees.ts` : **pas de route THORChain tant que le propriétaire n'a pas enregistré de THORName**.
- **NEAR Intents 1Click** en direct (BTC, LTC, DOGE, XRP, TRON, Cardano, BCH, Zcash…) : les frais d'application (`appFees`) sont versés à un **compte NEAR**. Non activé.

Ce qui marche déjà vers ces chaînes : **l'arrivée sur Bitcoin** (depuis EVM ou Solana, frais pris au départ).

## 1inch : retiré

1inch ne verse les frais partenaires que sur une **offre payante** : sur l'offre gratuite, il reçoit `fee` et `referrer` mais les ignore sans erreur, si bien que le swap passerait sans commission. Comme il n'existe pas d'autre mécanisme officiel, et que Kyro n'ajoute jamais de transfert lui-même, 1inch a été retiré (fournisseur, clé API, hôte `api.1inch.dev` de l'allowlist). 0x et LI.FI couvrent l'EVM.

## Ce que les fournisseurs prennent eux-mêmes

Ce sont les frais propres à chaque fournisseur, en plus de ceux de Kyro et sans aucun lien avec eux. Ils sont déjà compris dans le prix annoncé ou dans les frais réseau affichés.

- **0x** : 0,15 % sur certaines paires (offre Standard), renvoyés dans `fees.zeroExFee`. Le gain de slippage positif revient à 0x, sauf sur offre personnalisée.
- **LI.FI** : 0,25 % de frais de service, prélevés en plus de la commission Kyro.
- **Jupiter (Metis)** : aucune part des frais de plateforme annoncée.

## Non vérifié à ce jour

- **Aucun swap réel n'a été envoyé** : tout est testé contre des réponses simulées, plus de vraies réponses li.quest (deux sur une même chaîne, cinq entre chaînes avec le statut 1Click de leur dépôt) et deux vraies transactions Jupiter (01/11/2026, non signées) que le décodeur accepte telles quelles. Les agrégateurs et les ponts ne fonctionnent pas sur testnet.
- **Entre chaînes** : la livraison à l'arrivée dépend du réseau de solveurs de NEAR Intents (remboursement sur l'adresse de départ s'il échoue). Kyro vérifie ce qui est signé et ce que le pont s'engage à faire, pas la livraison. LI.FI applique le slippage à **chaque** étape (swap de départ puis pont) : Kyro demande la moitié du slippage choisi par étape, puis exige que le minimum du pont respecte le slippage choisi. L'adresse du portefeuille de frais LI.FI sur Solana (`34FK…xjgm`) n'est pas documentée par LI.FI : relevée dans les vraies transactions ; si elle change, les départs Solana sont refusés jusqu'à mise à jour.
- **0x** : le décodage n'a pas été confronté à une vraie réponse (clé API nécessaire) ; il suit les interfaces publiées (`IAllowanceHolder.exec`, `ISettlerTakerSubmitted.execute`). Une vente de jeton natif dont `transaction.to` ne serait pas AllowanceHolder est refusée (comportement non documenté par 0x), tout comme un échange ETH ⇄ WETH (adressé directement au contrat WETH).
- **0x** : la documentation ne dit pas noir sur blanc si `buyAmount` est déjà net des frais intégrateur. Kyro prélève les frais sur le jeton vendu : le montant annoncé correspond à ce qui est réellement échangé.
- **Jupiter** : la doc de Metis le déclare désormais « plus maintenu », remplacé par Swap V2 (`api.jup.ag/swap/v2`), et `lite-api.jup.ag` est retiré petit à petit. Migrer change d'hôte, donc il faudra mettre à jour en même temps l'allowlist, `NETWORK.md` et `IPC.md`.
