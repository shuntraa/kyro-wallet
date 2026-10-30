# Sécurité de Kyro

Kyro est un wallet **non-custodial** : personne d'autre que toi n'a tes clés, pas même les développeurs. Ce document explique honnêtement ce que Kyro protège, comment, et ce qu'**aucun logiciel** ne peut protéger.

> Version 0.1 — **logiciel non audité, en développement, testnet par défaut.** N'y mets pas d'argent que tu ne peux pas perdre tant qu'un audit externe n'a pas été publié.

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
| Secrets en mémoire | Types `Zeroizing` : phrase, graine et clés effacées de la mémoire après usage. Les clés privées sont dérivées **à chaque signature** puis effacées ; la graine n'est gardée que pendant la session déverrouillée. |
| Signature | **Uniquement en Rust.** Chaque signature exige le mot de passe (re-vérifié par Argon2id) **et** une confirmation dans une **fenêtre système native**, qui affiche le résumé décodé par Rust — pas par l'interface. |
| Auto-lock | Verrouillage après inactivité (15 min par défaut), à la mise en veille et à la fermeture ; la session est effacée. |
| Interface | CSP stricte, aucun script distant, aucune police ou image distante, aucune télémétrie. Allowlist des commandes Tauri (moindre privilège), pas d'accès au système de fichiers ni au shell. |
| Tor intégré | Par défaut, tout le trafic réseau passe par **Tor** (client Arti embarqué, TLS de bout en bout jusqu'au serveur) : les serveurs ne voient pas ton IP, et chaque famille d'activité (Bitcoin, Litecoin, Dogecoin, TRON, XRP, EVM, Solana, marché, swap) a ses propres circuits isolés. Bitcoin passe par le service onion officiel de mempool (aucun relais de sortie). **Échec fermé** : si Tor n'est pas prêt, aucune requête ne part en clair. Le mode clair est un choix explicite. Les serveurs voient toujours les adresses demandées (voir [docs/NETWORK.md](docs/NETWORK.md)). |
| Serveurs personnalisés | Chaque chaîne peut utiliser ton propre serveur (Esplora, Electrum, Bitcoin Core, RPC EVM/Solana), vérifié à l'enregistrement (bon réseau) et **sans repli silencieux** vers le serveur par défaut. Electrum : certificat validé, ou **épinglé** par son empreinte SHA-256 (confirmée par toi à la première connexion) ; jamais de certificat non validé et non épinglé. Bitcoin Core : portefeuille de **surveillance** sans clé privée (descripteurs publics uniquement). |
| Filtres compacts Bitcoin (BIP157/158, fonction `cbf`, désactivée par défaut jusqu'à revue) | Tes adresses ne quittent jamais ta machine : les filtres sont comparés localement. Avec Tor activé, la bibliothèque P2P n'a **aucune** sortie directe : elle passe par un pont SOCKS interne limité aux pairs fournis par Kyro (loopback, port aléatoire, sans DNS), ouvert seulement pendant la synchronisation. Les pairs voient quels blocs tu télécharges (signal faible, documenté). |
| Identifiants RPC Bitcoin Core | **Préfère le fichier `.cookie`** de ton nœud : Kyro le relit à chaque requête et ne le copie pas. Si tu utilises `rpcuser`/`rpcpassword`, le mot de passe est **stocké en clair** dans `settings.json`, dans le dossier de données de l'app (il n'est jamais renvoyé à l'interface, qui ne voit que « mot de passe enregistré ») : quiconque lit ce dossier peut piloter ton nœud. |
| Réseau | L'interface ne peut joindre aucun serveur : tout passe par une commande Rust qui n'autorise que les domaines listés dans [docs/NETWORK.md](docs/NETWORK.md) (HTTPS, sans redirection hors liste, taille et durée plafonnées). |
| Presse-papier | Après un collage d'adresse, l'adresse est affichée en blocs (début et fin mis en évidence) ; si le champ change sans que tu l'aies tapé, l'envoi est bloqué. |
| Affichage de la phrase | Avertissement, pas de bouton copier, captures d'écran bloquées quand l'OS le permet (complet sous Windows, partiel sous macOS, indisponible sous Linux). |
| Autorisations ERC-20 | Montant **exact** par défaut. Un montant illimité exige une action explicite et affiche un avertissement. Les autorisations actives sont listées et révocables. |
| Chaîne d'approvisionnement | Dépendances épinglées à la version exacte, lockfiles commités, `cargo audit`, `cargo deny` et `pnpm audit` en CI, délai de 3 jours avant d'accepter une nouvelle version npm, toolchain Rust épinglée. |

## Modèle de menace

### Ce que Kyro protège

| Menace | Protection |
|---|---|
| Vol de l'ordinateur ou du disque, sauvegarde cloud du dossier de l'app | Coffre chiffré ; sans le mot de passe, la phrase est inaccessible. La solidité dépend de **ton mot de passe** : choisis-en un long. |
| Interface compromise (XSS via un nom de token, dépendance npm malveillante) | L'interface n'a ni secret ni réseau. Elle ne peut pas signer sans ton mot de passe et sans la fenêtre système, qui montre ce que Rust a réellement décodé. |
| Logiciel qui remplace les adresses dans le presse-papier | Surveillance du collage, adresse affichée en blocs, carnet d'adresses. |
| Empoisonnement d'adresse (fausse adresse ressemblante dans l'historique) | Alerte quand une adresse ressemble à une adresse connue sans être identique. |
| API ou nœud malveillant (prix faux, devis de swap piégé) | Décodage indépendant en Rust, simulation avant signature quand c'est possible, montant minimum reçu, autorisation exacte, possibilité d'utiliser ton propre nœud. Un nœud peut toutefois mentir sur ton solde : utilise ton propre nœud si c'est critique. |
| Regard indiscret ou capture pendant l'affichage de la phrase | Avertissement, blocage des captures selon l'OS, pas de copie. |
| Litecoin : interface ou serveur qui ment sur une pièce dépensée (montant, script) | La PSBT doit porter `witness_utxo` ; le sighash BIP143 engage le montant de chaque entrée signée ; Rust vérifie que la clé dérivée correspond à la clé et au script dépensé, refuse tout sighash ≠ ALL, calcule frais, taux et taille lui-même et les affiche dans la fenêtre native. Limite connue (comme Bitcoin SegWit v0 en logiciel) : `non_witness_utxo` n'est pas exigé, donc deux sessions de signature manipulées pourraient faire payer des frais imprévus (« bug des frais SegWit ») ; chaque session reste confirmée séparément dans la fenêtre native. |
| Dogecoin : montant d'entrée falsifié (le sighash legacy n'engage pas les montants) | Chaque entrée doit porter la **transaction précédente complète** ; Rust recalcule son txid et exige qu'il soit celui de l'outpoint : un montant gonflé change le txid et la PSBT est refusée. Le serveur qui fournit cette transaction (`doge_tx_hex`) est aussi vérifié par son txid. |
| Sortie inconnue, OP_RETURN, entrée étrangère, poussière douce Dogecoin, frais démesurés (LTC/DOGE) | Affichés tels quels (« Sortie INCONNUE », script hex) puis **2ᵉ dialogue renforcé** obligatoire. Une sortie sous la poussière dure (refusée par le réseau) est refusée avant signature. |
| Adresse Bitcoin collée dans un envoi Litecoin | Refusée : `bc1…`/`1…` ne sont pas des adresses Litecoin, et l'ancien format P2SH `3…` (que Litecoin Core accepte encore) est refusé exprès ; l'adresse `M…` du même script reste possible. |
| TRON : serveur ou interface qui fournit une transaction piégée | Kyro **construit lui-même** `raw_data` (dernier bloc, contrat, `fee_limit`) ; avant signature, Rust le redécode avec un décodeur strict qui exige un ré-encodage identique octet pour octet (pas de champ ignoré ni de doublon interprété autrement que par java-tron), refuse tout contrat autre que transfert TRX / appel de contrat — donc **changement de permissions** (`AccountPermissionUpdate`), gel, vote, délégation —, `Permission_id`, autre propriétaire, `auths`/`scripts`, valeur TRC-10, et expiration passée ou à plus de 24 h. Un appel qui n'est pas `transfer(address,uint256)` (par ex. `approve`), des TRX envoyés au contrat, un mémo ou un `fee_limit` > 100 TRX exigent la 2ᵉ confirmation renforcée. |
| TRON : frais brûlés inattendus | La fenêtre native montre bande passante et énergie nécessaires / disponibles, les TRX brûlés estimés et **au maximum** (`fee_limit`, plafond dur côté protocole), et le coût d'**activation** d'un compte destinataire inexistant (1 TRX + 0,1 TRX), relus en direct au moment de signer. Limite : l'énergie est une simulation du serveur ; un serveur menteur peut sous-estimer, mais pas dépasser le `fee_limit` affiché. Un token TRC-20 inconnu est affiché en unités brutes, le symbole de l'interface étant marqué « non vérifié ». |
| XRP : transaction piégée par l'interface ou le serveur | Kyro **construit lui-même** le Payment (séquence, frais, registre limite lus au serveur, encodage wallet-core) ; avant signature, décodage strict à ré-encodage identique : **seuls les Payment** de notre compte avec notre clé sont signés — jamais AccountSet, **SetRegularKey**, **SignerListSet** (prise de contrôle du compte), TrustSet, offres, escrow… ; paiement partiel (`tfPartialPayment`), `Paths`, `DeliverMin`, champs ou drapeaux inconnus refusés ; SendMax, mémo, InvoiceID, frais > 1 XRP → 2ᵉ confirmation renforcée. Signature DER **low-S** (canonique). |
| XRP : fonds perdus faute de tag de destination, réserve | Le tag de destination est encadré dans la fenêtre native (ou « AUCUN TAG DE DESTINATION » avec avertissement) ; un destinataire qui exige un tag (`lsfRequireDestTag`, relu en direct) sans tag est **refusé** ; un paiement à un compte inexistant sous la réserve de base (1 XRP) est refusé avant signature ; le disponible affiché est solde − réserve (1 XRP + 0,2 XRP par objet). Les X-addresses sont refusées (adresse classique + tag séparé, pour que le tag soit toujours visible). |
| Signature croisée entre chaînes | Mainnet : chemins distincts (`84'/0'` BTC, `84'/2'` LTC, `44'/3'` DOGE), une PSBT d'une autre chaîne ne trouve aucune clé « à nous ». **Testnet** : la convention SLIP-44 (coin type 1) donne à Litecoin testnet les **mêmes clés** que Bitcoin testnet BIP84 (et à Dogecoin testnet celles de Bitcoin testnet BIP44) : une PSBT Bitcoin testnet présentée à `ltc_sign_psbt` serait signée et affichée en `tltc1…`. Sans valeur sur testnet, mais à savoir (et ces adresses sont liables entre testnets). |

### Ce qu'aucun logiciel ne peut protéger

- **Un malware avec le contrôle total de ta machine pendant que le coffre est déverrouillé.** Il peut lire la mémoire, enregistrer tes frappes (donc ton mot de passe) et piloter l'application. C'est la limite de tout wallet logiciel.
- **Un keylogger + une copie du fichier du coffre** : avec les deux, le coffre peut être ouvert.
- Un système d'exploitation, un firmware ou un matériel compromis.
- Toi qui donnes ta phrase de récupération (faux support, faux site, faux « airdrop »). **Personne de légitime ne te la demandera jamais.**
- La coercition physique.

**D'où notre recommandation : utilise un hardware wallet** (Ledger, Trezor). Les clés restent dans l'appareil et chaque transaction se vérifie sur son écran, même si l'ordinateur est infecté. *(Code écrit en phase 1.5, testé contre des échanges enregistrés et des simulations, **pas encore contre un vrai appareil ni un émulateur** : voir ci-dessous.)*

## Hardware wallets (Ledger, Trezor)

Détails techniques : [docs/IPC.md §2.3](docs/IPC.md).

### Ce que l'appareil protège

- **Les clés privées** ne quittent jamais l'appareil ; Kyro ne stocke que des clés publiques (xpubs, adresses) dans `hw-accounts-<réseau>.json`, à côté du coffre (le coffre lui-même n'est pas modifié).
- **La confirmation finale** se fait sur l'écran de l'appareil, que l'ordinateur ne contrôle pas. Un malware peut modifier ce que Kyro affiche, mais pas ce que l'appareil affiche ni ce qu'il signe sans ton accord physique.
- Le PIN (et la passphrase sur Trezor T / Safe) se saisit **sur l'appareil**. Sur Trezor One, le PIN passe par une grille aveugle : Kyro ne reçoit que des positions, inutiles sans l'appareil. Une passphrase à taper sur l'ordinateur (Trezor One) est refusée.

### Ce que Kyro fait quand même (ne jamais faire confiance à l'appareil ni à l'ordinateur)

| Étape | Mesure |
|---|---|
| Avant de signer | Rust décode la transaction et l'affiche dans la **fenêtre système native** (destinataire, montant, token, frais, monnaie, mémo) ; tout ce qui est inconnu (sortie BTC non décodée, appel de contrat, instruction Solana inconnue) ou que l'appareil ne pourra pas afficher (**blind signing**) exige une **2ᵉ confirmation renforcée**. |
| Bon appareil ? | Avant toute signature ou tout affichage d'adresse, Kyro relit les clés de l'appareil et les compare au compte enregistré (`HW_WRONG_DEVICE`). |
| Adresse de réception | `hw_verify_address` affiche l'adresse **sur l'appareil** et la compare à celle que Kyro dérive lui-même de l'xpub enregistrée ; toute différence est une erreur bloquante (`HW_ADDRESS_MISMATCH`). Vérifie-la sur l'écran de l'appareil avant de la communiquer. |
| Après la signature | Chaque signature est vérifiée par libsecp256k1 / ed25519-dalek contre la clé attendue et le sighash (BIP143/BIP341) ou le hash (EIP-1559) recalculé par Rust ; adresse EVM récupérée = adresse attendue, low-S exigé ; Solana en vérification stricte. Une signature fausse, manquante ou pour une autre entrée est refusée (`HW_BAD_RESPONSE`). |
| Transport | Un verrou par appareil, délais bornés, annulation et débranchement gérés : l'opération est abandonnée proprement, jamais d'attente infinie, rien n'est renvoyé à moitié. |

### Ce qui reste à risque

- **Blind signing.** Quand l'appareil ne sait pas décoder (appel de contrat, ERC-20 sans descripteur sur Ledger, certaines instructions Solana), son écran ne montre qu'une empreinte ou des données brutes : seul le résumé de Kyro décrit la transaction, et un ordinateur compromis peut falsifier ce résumé. Kyro le signale par une confirmation renforcée ; garde le blind signing **désactivé** dans les apps Ledger tant que tu n'en as pas besoin.
- **Descripteurs ERC-20 Ledger (« CAL »).** Pour qu'un Ledger affiche un token en clair, Ledger signe un descripteur (symbole, contrat, décimales, chaîne). Kyro n'appelle **pas** le service de Ledger : il embarque quelques descripteurs (USDC et USDT mainnet, tUSDC Sepolia) téléchargés une fois et **vérifiés** contre la clé publique publiée par Ledger (dans les tests et avant chaque usage). C'est une confiance déléguée à Ledger : un descripteur signé par erreur par Ledger serait affiché comme authentique. Ajouter des tokens demanderait soit de les embarquer à chaque version, soit d'interroger `crypto-assets-service.api.ledger.com` (nouvel hôte, via l'allowlist et Tor) — non fait.
- **Chaîne d'approvisionnement de l'appareil.** Un appareil contrefait, intercepté ou au firmware piégé peut afficher une chose et en signer une autre, ou générer des clés prévisibles. Achète-le directement chez le fabricant, vérifie son authenticité (Ledger : vérification « Genuine » ; Trezor : contrôle d'authenticité dans Trezor Suite), garde le firmware à jour, et ne l'initialise qu'avec une phrase générée par l'appareil lui-même. Kyro ne peut pas détecter un appareil malveillant qui signe correctement la transaction affichée par Kyro.
- **Fichier des comptes.** `hw-accounts-*.json` contient des xpubs en clair : quiconque lit ce fichier connaît toutes tes adresses et ton historique (vie privée, pas les fonds). Quelqu'un qui peut l'**écrire** pourrait y mettre ses propres xpubs : Kyro afficherait alors de fausses adresses de réception tant que l'appareil n'est pas branché. D'où la règle : **vérifie toujours une adresse de réception sur l'appareil** (`hw_verify_address`), qui détecte la substitution ; la signature, elle, relit toujours les clés de l'appareil d'abord.
- **Bibliothèques C.** Le transport USB s'appuie sur hidapi (Ledger, C sur Windows/macOS) et libusb (Trezor, C, LGPL-2.1+, liée statiquement), les voies standard ; elles tournent dans le processus de Kyro.

### Litecoin et Dogecoin sur hardware wallet

Non pris en charge (`HW_UNSUPPORTED`) : conception dans [docs/IPC.md §2.3](docs/IPC.md). Les mêmes règles s'appliqueraient (dialogue natif, vérification de chaque signature par Rust).

## Vérifier une release

Les binaires seront publiés avec leurs empreintes SHA-256 et une signature. Pour reconstruire toi-même : voir la section *Build* du [README](README.md). Les builds reproductibles bit à bit sont un objectif, pas encore une garantie.
