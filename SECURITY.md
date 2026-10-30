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

### Ce qu'aucun logiciel ne peut protéger

- **Un malware avec le contrôle total de ta machine pendant que le coffre est déverrouillé.** Il peut lire la mémoire, enregistrer tes frappes (donc ton mot de passe) et piloter l'application. C'est la limite de tout wallet logiciel.
- **Un keylogger + une copie du fichier du coffre** : avec les deux, le coffre peut être ouvert.
- Un système d'exploitation, un firmware ou un matériel compromis.
- Toi qui donnes ta phrase de récupération (faux support, faux site, faux « airdrop »). **Personne de légitime ne te la demandera jamais.**
- La coercition physique.

**D'où notre recommandation : utilise un hardware wallet** (Ledger, Trezor). Les clés restent dans l'appareil et chaque transaction se vérifie sur son écran, même si l'ordinateur est infecté. *(Support prévu : phase 1.5, pas encore disponible dans la v0.1.)*

## Vérifier une release

Les binaires seront publiés avec leurs empreintes SHA-256 et une signature. Pour reconstruire toi-même : voir la section *Build* du [README](README.md). Les builds reproductibles bit à bit sont un objectif, pas encore une garantie.
