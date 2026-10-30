# Sécurité de Kyro

Kyro est un wallet **non-custodial** : personne d'autre que toi n'a tes clés, pas même les développeurs. Ce document explique honnêtement ce que Kyro protège, comment, et ce qu'**aucun logiciel** ne peut protéger.

> Version 0.1 — **logiciel non audité, en développement, testnet par défaut.** N'y mets pas d'argent que tu ne peux pas perdre tant qu'un audit externe n'a pas été publié. **Aucune fenêtre de confirmation native n'a encore été cliquée par un humain dans l'application réelle** : les envois réels de test sont passés par les mêmes fonctions Rust, sans interface (voir [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

## Signaler une faille

Ne publie pas la faille dans une issue publique. Écris à l'adresse indiquée dans le profil GitHub du projet (rubrique *Security → Report a vulnerability*), avec une preuve de concept si possible. Accusé de réception sous 72 h ; correctif et divulgation coordonnée sous 90 jours maximum.

## Architecture de sécurité

```
 Interface React (webview)     ─ aucun secret, aucun accès réseau direct
        │ invoke() — allowlist de commandes Tauri
 Coque Tauri (Rust)            ─ session, auto-lock, réseau filtré, dialogue de confirmation natif
        │
 wallet-core (Rust pur)        ─ chiffrement, dérivation, signature ; sans réseau ni fichiers
```

| Mesure | Détail |
|---|---|
| Chiffrement au repos | Phrase de récupération chiffrée avec **XChaCha20-Poly1305** ; clé dérivée du mot de passe par **Argon2id** (256 Mio, 3 passes, 4 voies). En-tête (version, paramètres, sel) authentifié : toute modification fait échouer le déchiffrement. |
| Secrets en mémoire | Types `Zeroizing` : phrase, graine et clés effacées de la mémoire après usage. Les clés privées sont dérivées **à chaque signature** puis effacées ; la graine (et, pour Cardano, la racine Icarus) n'est gardée que pendant la session déverrouillée. |
| Signature | **Uniquement en Rust.** Chaque signature exige le mot de passe (re-vérifié par Argon2id) **et** une confirmation dans une **fenêtre système native**, qui affiche le résumé décodé par Rust — pas par l'interface. Tout ce qui est inconnu ou inhabituel déclenche une **2ᵉ fenêtre renforcée**, sur toutes les chaînes (Bitcoin, EVM, Solana, Litecoin, Dogecoin, TRON, XRP, Cardano) et sur hardware wallet (déclencheurs : voir chaque chaîne). |
| Auto-lock | Verrouillage après inactivité (15 min par défaut), à la mise en veille et à la fermeture ; la session est effacée. |
| Interface | CSP stricte, aucun script distant, aucune police ou image distante, aucune télémétrie. Allowlist des commandes Tauri (moindre privilège), pas d'accès au système de fichiers ni au shell. |
| Tor intégré | Par défaut, tout le trafic réseau passe par **Tor** (client Arti embarqué, TLS de bout en bout jusqu'au serveur) : les serveurs ne voient pas ton IP, et chaque famille d'activité (Bitcoin, Litecoin, Dogecoin, TRON, XRP, Cardano, EVM, Solana, marché, swap) a ses propres circuits isolés. Bitcoin passe par le service onion officiel de mempool (aucun relais de sortie). **Échec fermé** : si Tor n'est pas prêt, aucune requête ne part en clair. Le mode clair est un choix explicite. Les serveurs voient toujours les adresses demandées (voir [docs/NETWORK.md](docs/NETWORK.md)). |
| Serveurs personnalisés | Chaque chaîne peut utiliser ton propre serveur (Esplora, Electrum, Bitcoin Core, RPC EVM/Solana, Esplora Litecoin/Dogecoin, java-tron, rippled, Koios), vérifié à l'enregistrement (bon réseau) et **sans repli silencieux** vers le serveur par défaut. Electrum : certificat validé, ou **épinglé** par son empreinte SHA-256 (confirmée par toi à la première connexion) ; jamais de certificat non validé et non épinglé. Bitcoin Core : portefeuille de **surveillance** sans clé privée (descripteurs publics uniquement). |
| Filtres compacts Bitcoin (BIP157/158, fonction `cbf`, désactivée par défaut jusqu'à revue) | Tes adresses ne quittent jamais ta machine : les filtres sont comparés localement. Avec Tor activé, la bibliothèque P2P n'a **aucune** sortie directe : elle passe par un pont SOCKS interne limité aux pairs fournis par Kyro (loopback, port aléatoire, sans DNS), ouvert seulement pendant la synchronisation. Les pairs voient quels blocs tu télécharges (signal faible, documenté). |
| Identifiants RPC Bitcoin Core | **Préfère le fichier `.cookie`** de ton nœud : Kyro le relit à chaque requête et ne le copie pas. Si tu utilises `rpcuser`/`rpcpassword`, le mot de passe est **stocké en clair** dans `settings.json`, dans le dossier de données de l'app (il n'est jamais renvoyé à l'interface, qui ne voit que « mot de passe enregistré ») : quiconque lit ce dossier peut piloter ton nœud. |
| Clés API (CoinGecko, 0x, 1inch, TronGrid) | Stockées **en clair** dans `settings.json` (dossier de données de l'app), comme le mot de passe Core : quiconque lit ce dossier peut les utiliser sur ton compte chez ces fournisseurs. **Jamais renvoyées à l'interface** : `settings_get` ne donne que « clé enregistrée : oui / non » (`apiKeysSet`), et une clé ne peut qu'être remplacée ou effacée, pas relue. Rust les injecte lui-même en en-tête **uniquement vers l'hôte de leur fournisseur** (par ex. TronGrid : `api.trongrid.io` et `nile.trongrid.io`, jamais un nœud personnel), et les retire si une redirection change d'hôte. Les clés d'environnement (`KYRO_…`) suivent la même règle. |
| Réseau | L'interface ne peut joindre aucun serveur : tout passe par une commande Rust qui n'autorise que les domaines listés dans [docs/NETWORK.md](docs/NETWORK.md) (HTTPS, sans redirection hors liste, taille et durée plafonnées). |
| Presse-papier | Après un collage d'adresse, l'adresse est affichée en blocs (début et fin mis en évidence) ; si le champ change sans que tu l'aies tapé, l'envoi est bloqué. |
| Empoisonnement d'adresse | L'écran Envoyer compare le destinataire aux **adresses de confiance** (carnet d'adresses, tes propres adresses, destinataires et expéditeurs réels de ton historique) sur leurs **4 premiers et 4 derniers caractères** (après le préfixe propre au format, par ex. `0x`, `tb1q`, `addr_test1`) : une adresse différente mais avec le même début et la même fin déclenche une **alerte rouge bloquante**, et continuer exige de cocher une case. Les expéditeurs qui ne t'ont envoyé que de la poussière ou des transferts de valeur nulle ne comptent **pas** comme adresses de confiance : ils sont traités comme suspects. |
| Affichage de la phrase | Avertissement, pas de bouton copier, captures d'écran bloquées quand l'OS le permet (complet sous Windows, partiel sous macOS, indisponible sous Linux). |
| Autorisations ERC-20 | Montant **exact** par défaut dans les swaps. Un montant illimité exige une action explicite et affiche un avertissement (« ILLIMITÉ » aussi dans la fenêtre native). |
| Chaîne d'approvisionnement | Dépendances épinglées à la version exacte (≥ 2 semaines d'ancienneté), lockfiles commités, `cargo audit`, `cargo deny` et `pnpm audit` en CI, délai de 3 jours avant d'accepter une nouvelle version npm, toolchain Rust épinglée. |

## Modèle de menace

### Ce que Kyro protège (toutes chaînes)

| Menace | Protection |
|---|---|
| Vol de l'ordinateur ou du disque, sauvegarde cloud du dossier de l'app | Coffre chiffré ; sans le mot de passe, la phrase est inaccessible. La solidité dépend de **ton mot de passe** : choisis-en un long. Attention : `settings.json` (clés API, mot de passe Core éventuel) et `hw-accounts-*.json` (xpubs) ne sont **pas** chiffrés. |
| Interface compromise (XSS via un nom de token, dépendance npm malveillante) | L'interface n'a ni secret ni réseau. Elle ne peut pas signer sans ton mot de passe et sans la fenêtre système, qui montre ce que Rust a réellement décodé. Sur TRON, XRP et Cardano, Rust **construit lui-même** la transaction : l'interface ne fournit que destinataire et montant. |
| Logiciel qui remplace les adresses dans le presse-papier | Surveillance du collage, adresse affichée en blocs, carnet d'adresses. |
| Empoisonnement d'adresse (une adresse sosie glissée dans ton historique par une transaction de poussière ou de valeur nulle) | Alerte rouge bloquante si le destinataire a les mêmes 4 premiers et 4 derniers caractères qu'une adresse de confiance sans être identique ; les sosies venus de poussière ne sont jamais « de confiance ». Limite : un sosie qui diffère déjà dans ces 8 caractères n'est pas détecté — vérifie l'adresse entière, ou copie-la depuis Recevoir ou le carnet. |
| Regard indiscret ou capture pendant l'affichage de la phrase | Avertissement, blocage des captures selon l'OS, pas de copie. |
| Serveur qui ment | Voir chaque chaîne : en général un serveur peut mentir sur **ce que tu possèdes et ce qui s'est passé** (solde, historique, existence d'un compte), pas sur **ce que tu signes**, que Rust décode lui-même. Pour être sûr de ton solde : ton propre nœud. |

### Ce qu'aucun logiciel ne peut protéger

- **Un malware avec le contrôle total de ta machine pendant que le coffre est déverrouillé.** Il peut lire la mémoire, enregistrer tes frappes (donc ton mot de passe), afficher une fausse fenêtre et piloter l'application. C'est la limite de tout wallet logiciel.
- **Un keylogger + une copie du fichier du coffre** : avec les deux, le coffre peut être ouvert.
- Un système d'exploitation, un firmware ou un matériel compromis.
- Toi qui donnes ta phrase de récupération (faux support, faux site, faux « airdrop »). **Personne de légitime ne te la demandera jamais.**
- Toi qui confirmes une transaction que tu n'as pas lue : la fenêtre native ne protège que si tu la lis.
- La coercition physique.

**D'où notre recommandation : utilise un hardware wallet** (Ledger, Trezor) quand ce sera testé. Les clés restent dans l'appareil et chaque transaction se vérifie sur son écran, même si l'ordinateur est infecté. *(Code écrit, testé contre des échanges enregistrés et des simulations, **pas encore contre un vrai appareil ni un émulateur** : voir plus bas.)*

## Modèle de menace par chaîne

Pour chaque chaîne : ce que Rust décode et refuse avant de signer ; ce que le serveur peut falsifier et ce que ça change ; les arnaques propres à la chaîne ; ce qui reste à risque.

### Bitcoin (BIP84 SegWit, BIP86 Taproot)

- **Rust décode et refuse.** La PSBT est décodée par rust-bitcoin ; chaque entrée doit porter `witness_utxo` (et `non_witness_utxo`, s'il est présent, doit concorder avec l'outpoint) ; la clé dérivée doit être celle de la PSBT et du script dépensé ; seuls `SIGHASH_ALL` / `SIGHASH_DEFAULT` sont signés ; frais négatifs et dépassements refusés ; les entrées qui ne sont pas à nous ne sont pas signées. La monnaie est reconnue sur 20 adresses de réception et 20 de monnaie par type. Une sortie non standard est affichée en `script:<hex>` ou `op_return:<hex>`.
- **Le serveur peut mentir sur** : le solde, l'historique, les UTXO (pièces inexistantes : la transaction est alors simplement rejetée par le réseau), les frais conseillés (frais trop hauts : **affichés** dans la fenêtre native avant signature). Il ne peut pas changer le montant d'une entrée SegWit sans changer ce que Rust affiche, puisque le sighash engage ce montant.
- **Arnaques.** Empoisonnement d'adresse (une adresse qui ressemble à la tienne glissée dans l'historique par une petite transaction) : l'**alerte d'empoisonnement d'adresse** de l'écran Envoyer s'applique (voir « Ce que Kyro protège ») ; copie quand même depuis l'écran Recevoir ou le carnet, jamais depuis l'historique. Arnaque à la poussière (petites pièces envoyées pour pister) : Kyro ne gèle pas ces pièces.
- **2ᵉ fenêtre renforcée** (coffre et hardware wallet) : sortie à script inconnu, OP_RETURN, entrée qui n'est pas à nous (non signée par Kyro : coinjoin, payjoin ou piège), frais au-dessus de **100 sat/vB** (100 × le minimum de relais) ou supérieurs au total des sorties. Un sighash autre que ALL / DEFAULT sur nos entrées est **refusé**, pas seulement signalé. Le résumé affiché est calculé comme celui de la signature et doit lui être identique.
- **Risques résiduels.** « Bug des frais SegWit » : `non_witness_utxo` n'est pas exigé, donc deux sessions de signature manipulées pourraient faire payer des frais imprévus ; chaque session reste confirmée séparément. **Aucune diffusion réelle sur testnet n'a encore été faite depuis Kyro** : les portefeuilles de test publics (« abandon … about » et Trezor « all × 12 », BIP84 et BIP86, 20 adresses de réception et 20 de monnaie chacun) n'ont aucune pièce testnet4 (vérifié via Tor le 30/10/2026), et les robinets testnet4 demandent un captcha.

### Ethereum et chaînes EVM (Arbitrum, Optimism, Base, Polygon, BNB Chain, Avalanche)

- **Rust décode et refuse.** Transactions EIP-1559 uniquement (pas de création de contrat) ; Rust reconnaît transfert natif, `transfer` ERC-20 et `approve` ERC-20 (montant, spender, **« ILLIMITÉ »** si le montant est démesuré), le reste est affiché comme « Appel de contrat : adresse, valeur envoyée » ; la fenêtre montre le réseau (nom connu ou « chaîne N », chain id signé) et les **frais maximum** (gas limit × max fee). Pas de signature de messages ni de données typées (EIP-712) : un « permit » ne peut pas être signé par Kyro.
- **Le serveur (RPC) peut mentir sur** : soldes natif et ERC-20, nonce (transaction bloquée ou remplacée), estimation de gas et prix (frais trop hauts, mais plafonnés par le maximum affiché), résultat de simulation (`eth_call` : un faux « ça passe »), décimales et symbole d'un token (le symbole fourni par l'interface est une indication ; le contrat et le montant brut viennent de Rust).
- **Arnaques.** **Autorisations illimitées** (`approve` max) : marquées « ILLIMITÉ » avec un avertissement ; montant exact par défaut dans les swaps. Faux tokens au même symbole : seul le contrat compte ; la liste de Kyro est courte et fixe. Empoisonnement d'adresse (transferts de 0 token depuis une adresse sosie) : l'**alerte d'empoisonnement d'adresse** de l'écran Envoyer s'applique (voir « Ce que Kyro protège ») ; les expéditeurs de transferts à 0 sont suspects d'office.
- **2ᵉ fenêtre renforcée** (coffre et hardware wallet) : tout appel de contrat autre qu'un `transfer` ERC-20 décodé ; **toute** autorisation (`approve`), avec le bénéficiaire et le montant (« ILLIMITÉ » en capitales dès 2^128) ; valeur native envoyée avec un appel ; chainId inconnu de Kyro ; frais maximum (gas limit × max fee) au-dessus de **0,05** de la monnaie native (ETH, L2 ETH, BNB), **50 POL** sur Polygon, **1 AVAX** sur Avalanche.
- **Risques résiduels.** Pour un appel de contrat, Rust **ne décode pas le calldata** : signer un appel inconnu revient à faire confiance à l'application qui l'a construit (le swap de Kyro, ou rien). Un envoi de valeur **sans** calldata vers une adresse qui se trouve être un contrat n'est pas détecté (Rust ne consulte pas le RPC pour signer). **Aucune diffusion réelle sur Sepolia ni sur un testnet L2** : aucun portefeuille de test public n'a d'ETH Sepolia (vérifié le 30/10/2026 : « abandon … about », Hardhat « test … junk » — 0,000000000000188 ETH, inutilisable —, Trezor « all × 12 ») ; les robinets demandent un captcha ou un solde mainnet ; les testnets L2 ne sont pas dans le registre de Kyro. La signature est vérifiée contre une vraie transaction mainnet.

### Solana (SOL, SPL, Token-2022)

- **Rust décode et refuse.** Messages legacy et v0 décodés en Rust ; les tables d'adresses (ALT) sont lues **par Rust** au RPC et vérifiées (propriétaire, non désactivée, index présents) ; échec fermé si une table manque. Instructions reconnues : transferts System, création de compte, transferts et `approve` SPL / Token-2022, création d'ATA, budget de calcul, mémo. Tout le reste est « inconnu ». **2ᵉ confirmation renforcée** si : instruction inconnue, **délégation** (`approve`), payeur des frais ≠ nous, autre signataire inscriptible, autorité ≠ nous. Refuse si notre adresse n'est pas signataire.
- **Le serveur peut mentir sur** : soldes, comptes de tokens, décimales d'un mint, **contenu des tables d'adresses** (une fausse table change les comptes affichés : Rust vérifie le format et le propriétaire du compte table, pas que son contenu est celui de la chaîne ; avec ton propre RPC, ce risque disparaît), blockhash récent (transaction expirée), frais de priorité.
- **Arnaques.** **Délégation** de tokens à un tiers (`approve`) : renforcée. **Nonce durable** (`AdvanceNonceAccount`) : une transaction signée reste valable indéfiniment et peut être diffusée plus tard ; Kyro ne la reconnaît pas (instruction inconnue → renforcée) et construit les siennes avec un blockhash récent. Changement de propriétaire (`Assign`, `SetAuthority`) : inconnu → renforcé. Faux tokens au même nom : seul le mint compte.
- **Risques résiduels.** Les extensions Token-2022 (frais de transfert, hooks) ne sont pas vérifiées : signalées, sans 2ᵉ fenêtre. Le décodage est testé sur 6 vraies transactions devnet et 9 000 messages mutés, et **7 transactions réelles devnet** sont passées par le chemin Rust de `sol_sign_tx` (SOL, SPL et Token-2022, table d'adresses, transaction v0 dont la table a été lue par Rust) ; ces messages étaient construits par le test, pas par l'adaptateur TypeScript.

### Litecoin (BIP84 `ltc1`)

- **Rust décode et refuse.** Comme Bitcoin (rust-bitcoin, `witness_utxo` exigé, BIP143, clé = script, sighash ≠ ALL refusé) ; adresses Bitcoin (`bc1…`, `1…`) et ancien P2SH `3…` refusées, MWEB refusé. Frais, taux et taille calculés par Rust. **Sortie inconnue, OP_RETURN, entrée étrangère, frais démesurés → 2ᵉ fenêtre renforcée** ; sortie sous la poussière refusée.
- **Le serveur (litecoinspace.org ou le tien) peut mentir sur** : solde, historique, UTXO, frais conseillés (affichés avant signature), transaction brute d'une entrée (vérifiée par son txid).
- **Arnaques.** Adresse Bitcoin collée par erreur : refusée. Empoisonnement d'adresse : l'**alerte d'empoisonnement d'adresse** de l'écran Envoyer s'applique (voir « Ce que Kyro protège »).
- **Risques résiduels.** Même « bug des frais SegWit » que Bitcoin. **Testnet** : la convention SLIP-44 (coin type 1) donne à Litecoin testnet les **mêmes clés** que Bitcoin testnet BIP84 ; une PSBT Bitcoin testnet présentée à `ltc_sign_psbt` serait signée (affichée en `tltc1…`). Sans valeur sur testnet, mais ces adresses sont liables entre testnets. Sur mainnet, les chemins diffèrent (`84'/0'` / `84'/2'`).

### Dogecoin (BIP44 P2PKH)

- **Rust décode et refuse.** Le sighash legacy n'engage pas les montants : chaque entrée doit porter la **transaction précédente complète**, dont Rust recalcule le txid (un montant gonflé change le txid → refus). Frais par taille (règles Dogecoin Core 1.14.9), poussière dure refusée, **poussière douce, sortie inconnue, frais démesurés → 2ᵉ fenêtre renforcée**.
- **Le serveur peut mentir sur** : solde, historique, UTXO ; la transaction précédente qu'il fournit est vérifiée par son txid. **Il n'y a pas de serveur par défaut** : il faut le tien (Esplora Dogecoin).
- **Arnaques.** Mêmes que Litecoin.
- **Risques résiduels.** **Jamais exécuté contre un vrai serveur Dogecoin.** Testnet : clés identiques à Bitcoin testnet BIP44 (même convention SLIP-44 que ci-dessus).

### TRON (TRX, TRC-20)

- **Rust décode et refuse.** Kyro **construit lui-même** `raw_data` (dernier bloc, contrat, `fee_limit`) ; avant signature, décodeur protobuf strict à ré-encodage identique octet pour octet. Refusés : tout contrat autre que transfert TRX et appel de contrat — donc **changement de permissions** (`AccountPermissionUpdate`), gel, vote, délégation —, `Permission_id`, autre propriétaire, `auths`/`scripts`, valeur TRC-10, expiration passée ou à plus de 24 h. **2ᵉ fenêtre renforcée** : appel qui n'est pas `transfer(address,uint256)` (donc **`approve`**), TRX envoyés au contrat, mémo, `fee_limit` > 100 TRX.
- **Le serveur (TronGrid ou le tien) peut mentir sur** : soldes TRX et USDT, historique, ressources (bande passante, énergie), **simulation d'énergie** d'un transfert TRC-20 (sous-estimée : tu brûles plus de TRX que prévu, **jamais plus que le `fee_limit` affiché**, plafond dur du protocole), existence du compte destinataire (coût d'activation 1 TRX + 0,1 TRX affiché ou non), bloc de référence (transaction rejetée).
- **Arnaques.** **Changement de permissions** (prise de contrôle multisig du compte, l'arnaque TRON la plus courante) : impossible à signer. **`approve` TRC-20 illimité** : renforcé. Faux USDT : seul le contrat compte ; Kyro ne nomme que l'USDT officiel (et le test USDT de Nile). Empoisonnement d'adresse (transferts de 0 USDT depuis des sosies) : très répandu sur TRON ; l'**alerte d'empoisonnement d'adresse** de l'écran Envoyer s'applique (voir « Ce que Kyro protège »), et ces expéditeurs à 0 sont suspects d'office.
- **Risques résiduels.** Un token TRC-20 inconnu est affiché en unités brutes. Une seule adresse utilisée (`m/44'/195'/0'/0/0`).

### XRP Ledger (XRP, monnaies émises)

- **Rust décode et refuse.** Kyro **construit lui-même** le Payment (séquence, frais, registre limite lus au serveur, codec binaire wallet-core) ; décodage strict à ré-encodage identique : **seuls les Payment** de notre compte avec notre clé — jamais AccountSet, **SetRegularKey**, **SignerListSet** (prise de contrôle du compte), TrustSet, offres, escrow… ; `Paths`, `DeliverMin`, `TicketSequence`, `NetworkID`, champs ou drapeaux inconnus refusés. **2ᵉ fenêtre renforcée** : SendMax, options de chemin, mémo, InvoiceID, frais > 1 XRP. Signature DER **low-S**.
- **Le serveur (rippled) peut mentir sur** : solde, **réserves** (base et par objet), **existence** du compte destinataire et son drapeau **« tag exigé »** (`lsfRequireDestTag`) — un serveur menteur peut te faire envoyer sans tag à une plateforme qui l'exige (fonds bloqués chez elle) ou sous la réserve à un compte inexistant (paiement refusé par le réseau, frais perdus) ; séquence et frais (transaction rejetée ou frais affichés plus hauts) ; le montant **livré** dans l'historique.
- **Arnaques.** **Paiement partiel** (`tfPartialPayment` : le destinataire reçoit presque rien alors qu'Amount montre gros ; arnaque classique contre les plateformes) : **refusé en signature**, et l'historique affiche le montant **réellement livré** (`delivered_amount`). **Tag de destination oublié** : encadré dans la fenêtre native (ou « AUCUN TAG DE DESTINATION »), et refusé si le destinataire l'exige. X-addresses refusées (adresse classique + tag séparé, pour que le tag soit toujours visible). Fausses monnaies émises : seul l'émetteur compte.
- **Risques résiduels.** Une seule adresse (`m/44'/144'/0'/0/0`). Lignes de confiance en lecture seule.

### Cardano (ADA, tokens natifs)

- **Rust décode et refuse.** Kyro **construit lui-même** la transaction (UTxO et paramètres lus à Koios, encodage wallet-core) ; décodage CBOR strict à ré-encodage identique : **seuls des paiements** (entrées, sorties ADA + tokens, frais, ttl, message CIP-20) — jamais de certificat (délégation, désinscription : dépôt et récompenses), retrait, mint, script Plutus, datum, collatéral, signataire requis, vote ou proposition de gouvernance ; sortie sous son min-UTxO, métadonnée autre qu'un message CIP-20, champ inconnu refusés. Au moment de signer, Rust **relit nos UTxO** : chaque entrée doit être un de nos UTxO non dépensés et entrées = sorties + frais (ADA et chaque token). Destinataires Byron, de script (fonds bloqués sans datum), pointeur, staking et d'un autre réseau refusés. **2ᵉ fenêtre renforcée** : message CIP-20, token hors table vérifiée, frais > 5 ADA, pas de ttl. Signature `ed25519-dalek` vérifiée, clé recoupée avec `ed25519-bip32`.
- **Le serveur (Koios ou le tien) peut mentir sur** : solde, tokens, historique, UTxO (faux UTxO : transaction rejetée par le nœud ; UTxO cachés : solde affiché plus bas) ; **paramètres de protocole** (bornés par Kyro ; un `min_fee` gonflé dans ces bornes fait payer plus, montant **affiché**) ; slot courant (ttl trop court ou trop long, affiché en minutes).
- **Arnaques.** **Faux tokens** au même nom (n'importe qui peut créer « USDM ») : chaque token est montré avec sa **policy id complète**, nom texte **et** hex, « vérifié » seulement pour DJED, USDM, iUSD (mainnet) ; tout autre → renforcé. Délégation à un pool piégé, désinscription de la clé de staking : impossibles à signer. Empoisonnement d'adresse : l'**alerte d'empoisonnement d'adresse** de l'écran Envoyer s'applique (voir « Ce que Kyro protège »).
- **Risques résiduels.** **Mode une seule adresse** : réception et monnaie sur la même adresse de base, qui contient ta clé de staking — tout ton historique Cardano est lié. Le CBOR est un sous-ensemble écrit à la main (pas `minicbor`, licence hors liste), testé contre les vecteurs Trezor et de vraies transactions preprod, mais jeune. **Une diffusion réelle preprod** (envoi à soi-même, frais minimum) depuis l'adresse publique des vecteurs CIP-19, dont la clé de paiement vient de la phrase de test publiée (le robinet preprod, lui, a un captcha). « Tout envoyer » laisse environ 1 ADA : Kyro garde toujours une sortie de monnaie.

## Hardware wallets (Ledger, Trezor)

Détails techniques : [docs/IPC.md §2.3](docs/IPC.md). **État : jamais exécuté contre un vrai appareil ni un émulateur** ; testé sur des échanges APDU enregistrés par Ledger et un firmware Trezor simulé. Chaînes : Bitcoin, EVM, Solana. Litecoin, Dogecoin, TRON, XRP et Cardano : `HW_UNSUPPORTED`.

### Ce que l'appareil protège

- **Les clés privées** ne quittent jamais l'appareil ; un malware sur l'ordinateur ne peut pas les lire.
- **La confirmation finale** se fait sur l'écran de l'appareil, que l'ordinateur ne contrôle pas. Un malware peut modifier ce que Kyro affiche, mais pas ce que l'appareil affiche ni ce qu'il signe sans ton accord physique — **à condition que l'appareil sache décoder la transaction** (voir blind signing).
- Le PIN (et la passphrase sur Trezor T / Safe) se saisit **sur l'appareil**.

### Ce que Kyro montre et vérifie quand même

| Étape | Mesure |
|---|---|
| Avant de signer | Rust décode la transaction et l'affiche dans la **fenêtre système native** (destinataire, montant, token, frais, monnaie, mémo) ; tout ce qui est inconnu (sortie BTC non décodée, appel de contrat, instruction Solana inconnue) ou que l'appareil ne pourra pas afficher (**blind signing**) exige une **2ᵉ confirmation renforcée**. |
| Bon appareil ? | Avant toute signature ou tout affichage d'adresse, Kyro relit les clés de l'appareil et les compare au compte enregistré (`HW_WRONG_DEVICE`). |
| Adresse de réception | `hw_verify_address` affiche l'adresse **sur l'appareil** et la compare à celle que Kyro dérive lui-même de l'xpub enregistrée ; toute différence est une erreur bloquante (`HW_ADDRESS_MISMATCH`). Vérifie-la sur l'écran de l'appareil avant de la communiquer. |
| Après la signature | Chaque signature est vérifiée par libsecp256k1 / ed25519-dalek contre la clé attendue et le sighash (BIP143/BIP341) ou le hash (EIP-1559) recalculé par Rust ; adresse EVM récupérée = adresse attendue, low-S exigé ; Solana en vérification stricte. Une signature fausse, manquante ou pour une autre entrée est refusée (`HW_BAD_RESPONSE`). |
| Transport | Un verrou par appareil, délais bornés, annulation et débranchement gérés : l'opération est abandonnée proprement, jamais d'attente infinie, rien n'est renvoyé à moitié. |

### Ce qui reste à risque

- **Blind signing.** Quand l'appareil ne sait pas décoder (appel de contrat, ERC-20 sans descripteur sur Ledger, certaines instructions Solana), son écran ne montre qu'une empreinte ou des données brutes : seul le résumé de Kyro décrit la transaction, et un ordinateur compromis peut falsifier ce résumé. Le hardware wallet ne protège alors plus que les clés, pas ton consentement. Kyro le signale par une confirmation renforcée ; garde le blind signing **désactivé** dans les apps Ledger tant que tu n'en as pas besoin.
- **Descripteurs ERC-20 Ledger (« CAL »).** Pour qu'un Ledger affiche un token en clair, Ledger signe un descripteur (symbole, contrat, décimales, chaîne). Kyro n'appelle **pas** le service de Ledger : il embarque quelques descripteurs (USDC et USDT mainnet, tUSDC Sepolia) téléchargés une fois et **vérifiés hors ligne** contre la clé publique publiée par Ledger (dans les tests et avant chaque usage). C'est une confiance déléguée à Ledger : un descripteur signé par erreur par Ledger serait affiché comme authentique. Ajouter des tokens demanderait soit de les embarquer à chaque version, soit d'interroger `crypto-assets-service.api.ledger.com` (nouvel hôte, via l'allowlist et Tor) — non fait.
- **Chaîne d'approvisionnement de l'appareil.** Un appareil contrefait, intercepté ou au firmware piégé peut afficher une chose et en signer une autre, ou générer des clés prévisibles. Achète-le directement chez le fabricant, vérifie son authenticité (Ledger : vérification « Genuine » ; Trezor : contrôle d'authenticité dans Trezor Suite), garde le firmware à jour, et ne l'initialise qu'avec une phrase générée par l'appareil lui-même. Kyro ne peut pas détecter un appareil malveillant qui signe correctement la transaction affichée par Kyro.
- **xpubs en clair sur le disque.** `hw-accounts-<réseau>.json`, à côté du coffre, contient des xpubs en **JSON non chiffré** : quiconque lit ce fichier connaît toutes tes adresses passées et futures et ton historique (vie privée, pas les fonds). Quelqu'un qui peut l'**écrire** pourrait y mettre ses propres xpubs : Kyro afficherait alors de fausses adresses de réception tant que l'appareil n'est pas branché. D'où la règle : **vérifie toujours une adresse de réception sur l'appareil** (`hw_verify_address`), qui détecte la substitution ; la signature, elle, relit toujours les clés de l'appareil d'abord.
- **Trezor One : grille du PIN.** Le Trezor One n'a pas de saisie du PIN sur l'appareil : il affiche une grille 3 × 3 mélangée, et tu cliques dans Kyro les **positions** correspondantes. Kyro ne reçoit que des positions, inutiles sans l'écran de l'appareil ; un malware qui voit l'écran de l'appareil (caméra) et tes clics pourrait reconstituer le PIN. Une passphrase à taper sur l'ordinateur (Trezor One) est **refusée**.
- **Trezor Safe 7 : non pris en charge.** Il utilise le nouveau protocole de canal chiffré THP, que Kyro n'implémente pas : il est détecté et refusé avec un message clair (`HW_UNSUPPORTED`).
- **Bibliothèques C.** Le transport USB s'appuie sur hidapi (Ledger, C sur Windows/macOS) et libusb (Trezor, C, LGPL-2.1+, liée statiquement), les voies standard ; elles tournent dans le processus de Kyro.

### Chaînes non prises en charge sur hardware wallet

Litecoin, Dogecoin, TRON, XRP et Cardano : `HW_UNSUPPORTED` (conception et besoins dans [docs/IPC.md](docs/IPC.md) §2.3 et §2.7). Les mêmes règles s'appliqueraient (dialogue natif, vérification de chaque signature par Rust).

## Vérifier une release

Les binaires seront publiés avec leurs empreintes SHA-256 et une signature. Pour reconstruire toi-même : voir la section *Build* du [README](README.md). Les builds reproductibles bit à bit sont un objectif, pas encore une garantie.
