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
| **LI.FI** | `distributionFees[0][receiver]`, `distributionFees[0][percentage]=0.007` (**en fraction**) | `recipients.evm`, versé directement (aucune inscription) | le jeton envoyé (`included` → déjà déduit de `toAmount`) | le devis doit renvoyer une ligne « Distributions » à 0,7 % vers ton adresse, sinon il est refusé |
| **Jupiter** (Metis `swap/v1`) | `platformFeeBps=70` sur `/quote`, `feeAccount` sur `/swap` | le compte de jetons associé (ATA) de `recipients.solana` | **USDC** pour l'instant (`solanaFeeMints`) : le jeton de sortie s'il est en USDC, sinon le jeton d'entrée | le devis doit renvoyer `platformFee.feeBps = 70`, sinon il est refusé |

Sources :
- 0x : [Monetize your app using Swap](https://docs.0x.org/evm/0x-swap-api/guides/monetize-your-app-using-swap.md)
- LI.FI : [Monetizing the integration](https://docs.li.fi/introduction/integrating-lifi/monetizing-integration)
- Jupiter : [Add fees to swap](https://developers.jup.ag/docs/swap-api/add-fees-to-swap)

## Ce que Kyro vérifie dans chaque devis

Les paramètres envoyés ne suffisent pas : un fournisseur pourrait renvoyer une transaction qui ne les respecte pas. Kyro décode donc la transaction **avant** de l'afficher, et de nouveau juste avant de signer (code : [`packages/swap/src/verify.ts`](../packages/swap/src/verify.ts), [`jupiter-verify.ts`](../packages/swap/src/jupiter-verify.ts)).

| Fournisseur | Frais Kyro contrôlés | Autres contrôles |
|---|---|---|
| **0x** | `fees.integratorFee` présent, pris dans le jeton vendu, **montant ≤ montant vendu × 70 / 10 000** ; l'adresse de frais doit figurer dans la transaction. Le détail de l'action Settler qui paie les frais n'est pas décodé. | `to` et autorisation = AllowanceHolder `0x0000000000001fF3684f28c67538d4D072C22734` ; Settler appelé = celui du registre `0x00000000000004533Fe15556B1E086BB1A72cEae` (`ownerOf(2)` ou `prev(2)`) ; destinataire = toi, minimum ≥ annoncé − slippage. |
| **LI.FI** | Étape `FeeForwarder` (`0xCE40449B773a3E6E5e769ADb4e567179d4828cbd`, `0x79C3F5B651Ee5782Ba15d968B088458cd5f1f4EF` sur Mantle) décodée : un versement à `recipients.evm`, **≤ montant vendu × 70 / 10 000** ; total des frais de cette étape ≤ 0,7 % + 0,5 % (part de LI.FI comprise). | `to` et autorisation = Diamond `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` ; `_receiver` = toi, `_minAmountOut` ≥ annoncé − slippage ; première et dernière étapes = jetons et montant de la paire. Routes entre chaînes refusées. |
| **Jupiter** | `platform_fee_bps` = 70 et compte de frais = le compte attendu de `recipients.solana` (lus dans l'instruction de route). | Payeur et seul signataire = toi ; programmes autorisés seulement (budget de calcul, ATA, emballage SOL, une route Jupiter v6) ; comptes débité et crédité à toi ; montant et slippage ; frais de priorité ≤ 0,01 SOL. |

Adresses relevées dans les dépôts officiels (0x : docs.0x.org et 0x-settler ; LI.FI : `lifinance/contracts`, `deployments/<chaîne>.json`) le 01/11/2026, identiques sur Ethereum, Arbitrum, Optimism, Base, Polygon, BNB Chain et Avalanche, et présents on-chain (`eth_getCode` non vide) sur les nouvelles chaînes retenues :

- **0x** aussi sur Sonic (liste « Cancun » de docs.0x.org) et HyperEVM (liste « Cancun » du README de 0x-settler). **Pas Mantle** : chaîne « Shanghai », autre AllowanceHolder (`0x0000000000005E88410CcDFaDe4a5EfaE4b49562`), non proposé plutôt que validé sur une seule lecture.
- **LI.FI** aussi sur Cronos, Mantle, Sonic, Gnosis et Sei (même Diamond ; FeeForwarder propre à Mantle). **Pas Flare, Kaia ni HyperEVM** : leur Diamond est une autre adresse (`0x198F…`, `0x1255…`, `0x0a07…`), non vérifiée par Kyro.

Le sélecteur de chaîne du Swap ne montre que les chaînes où au moins un de ces contrats est connu (`evmSwapSupported`) : ni Flare, ni Kaia, ni Conflux eSpace. Sur un autre réseau (testnet compris), aucun contrat n'est connu : les devis 0x et LI.FI sont refusés.

## Ce qu'il faut configurer avant d'encaisser

Tant que ces réglages manquent, les fournisseurs concernés sont écartés, et aucun swap ne part sans frais.

1. **`recipients.evm`** : ton adresse EVM. Elle reçoit les frais de 0x et de LI.FI sur toutes les chaînes EVM.
2. **`recipients.solana`** : ton adresse Solana, **le portefeuille lui-même, pas un compte de jetons**. Il doit posséder un **compte de jetons initialisé** pour chaque mint de `solanaFeeMints`, sinon la transaction Jupiter échoue.
   - Pour l'instant, c'est **USDC seul**. Le compte USDC de l'adresse configurée a été vérifié sur le réseau principal le 31/10/2026 : `CFPWYSxLRh79CobY4gLWzh15zgRgEgo2Cqb4e7gBQx7C`.
   - Jupiter ne peut prendre les frais que dans un des deux jetons du swap. Une paire Solana **sans USDC** (par exemple SOL → BONK) ne peut donc pas porter les frais, et Jupiter ne fait pas de devis pour elle.
   - Pour accepter aussi le SOL : crée le compte wSOL du portefeuille de frais (enveloppe un peu de SOL), puis ajoute le mint wSOL à `solanaFeeMints`.
3. **LI.FI** : rien à faire. Kyro utilise `distributionFees`, qui verse les frais directement à `recipients.evm`, sans inscription sur portal.li.fi. Vérifié par un vrai devis le 31/10/2026 (Arbitrum, USDC → ETH) : LI.FI renvoie « Distributions 0,7 % » vers l'adresse configurée. À l'inverse, un nom d'intégrateur non enregistré est refusé par LI.FI (`code 1011`).

## 1inch : retiré

1inch ne verse les frais partenaires que sur une **offre payante** : sur l'offre gratuite, il reçoit `fee` et `referrer` mais les ignore sans erreur, si bien que le swap passerait sans commission. Comme il n'existe pas d'autre mécanisme officiel, et que Kyro n'ajoute jamais de transfert lui-même, 1inch a été retiré (fournisseur, clé API, hôte `api.1inch.dev` de l'allowlist). 0x et LI.FI couvrent l'EVM.

## Ce que les fournisseurs prennent eux-mêmes

Ce sont les frais propres à chaque fournisseur, en plus de ceux de Kyro et sans aucun lien avec eux. Ils sont déjà compris dans le prix annoncé ou dans les frais réseau affichés.

- **0x** : 0,15 % sur certaines paires (offre Standard), renvoyés dans `fees.zeroExFee`. Le gain de slippage positif revient à 0x, sauf sur offre personnalisée.
- **LI.FI** : 0,25 % de frais de service, prélevés en plus de la commission Kyro.
- **Jupiter (Metis)** : aucune part des frais de plateforme annoncée.

## Non vérifié à ce jour

- **Aucun swap réel n'a été envoyé** : tout est testé contre des réponses simulées, plus deux vraies réponses li.quest et deux vraies transactions Jupiter (01/11/2026, non signées) que le décodeur accepte telles quelles. Les agrégateurs ne fonctionnent pas sur testnet.
- **0x** : le décodage n'a pas été confronté à une vraie réponse (clé API nécessaire) ; il suit les interfaces publiées (`IAllowanceHolder.exec`, `ISettlerTakerSubmitted.execute`). Une vente de jeton natif dont `transaction.to` ne serait pas AllowanceHolder est refusée (comportement non documenté par 0x), tout comme un échange ETH ⇄ WETH (adressé directement au contrat WETH).
- **0x** : la documentation ne dit pas noir sur blanc si `buyAmount` est déjà net des frais intégrateur. Kyro prélève les frais sur le jeton vendu : le montant annoncé correspond à ce qui est réellement échangé.
- **Jupiter** : la doc de Metis le déclare désormais « plus maintenu », remplacé par Swap V2 (`api.jup.ag/swap/v2`), et `lite-api.jup.ag` est retiré petit à petit. Migrer change d'hôte, donc il faudra mettre à jour en même temps l'allowlist, `NETWORK.md` et `IPC.md`.
