# Kyro Wallet — identité visuelle

## Le nom

**Kyro**, du grec *kruos*, « le froid ». Clin d'œil au *cold storage* : tes clés restent au froid, hors ligne, chez toi. Le produit s'appelle **Kyro Wallet** ; dans le logo, « kyro » est en gras et « wallet » en plus léger.

Signature : **« Tes clés restent au froid. »**

## Direction

- **Sombre en permanence.** Pas de thème clair : un coffre, c'est noir. Toute l'interface est pensée pour un fond quasi noir.
- **Un instrument de froid, pas un tableau de bord.** Encre bleu-noir, filets fins plutôt qu'une carte autour de tout, chiffres tabulaires, libellés en texte normal. Le solde et les courbes reposent sur la page, sur une ligne de base.
- **Un seul accent.** Le **bleu givre** (`#7CC4FF`) est réservé à la sélection, aux courbes et à ce qu'il faut vérifier (blocs d'adresse, reçu de vérification). L'action principale est en **blanc givré** (`#E4ECF3`, texte encre) ; tout le reste est un contour discret.
- **Courbes arrondies** : tous les graphiques passent par une interpolation Catmull-Rom → Bézier (aucun angle), avec un voile givre très léger sous la ligne.
- **Une vraie application desktop**, pas une page web : barre de titre intégrée, rail de navigation, barre d'état en bas (synchronisation, blocs, latence RPC, testnet, version).
- **« En clair ».** Chaque action sensible (envoi, swap, autorisation) est résumée en une phrase avant la signature.

## Mise en page

| Zone | Contenu |
|---|---|
| Barre de titre (40 px) | logo, compte actif, recherche `Ctrl K`, boutons de fenêtre |
| Rail (84 px) | Portefeuille, Actifs, Swap, Historique · en bas : Réglages, verrouiller |
| Contenu | écran courant ; Envoyer et Recevoir s'ouvrent depuis le Portefeuille avec un bouton retour |
| Barre d'état (28 px) | état réseau en `Geist Mono`, badge TESTNET, version |

Fenêtre de référence : **1440 × 900**. Taille minimale prévue : 1100 × 720.

## Comportement « app » (obligatoire)

- **Aucun texte sélectionnable** : `user-select: none` sur toute l'interface, sauf dans les champs de saisie.
- **Aucun surlignage bleu** : `::selection` transparent, `-webkit-tap-highlight-color: transparent`, pas de menu « copier » à l'appui long (`-webkit-touch-callout: none`).
- **Pas de glisser-déposer** des images et icônes (`-webkit-user-drag: none`).
- **Clic droit désactivé** hors des champs (côté Tauri : `contextmenu` bloqué).
- **Copie uniquement via les boutons « Copier »**, qui passent par le noyau Rust (et l'alerte presse-papier).
- Focus clavier visible uniquement à la navigation au clavier (`:focus-visible`, contour bleu givre 2 px).

## Logo

- **Anneau ouvert** : le code est ouvert.
- **Carré bleu givre au centre** : ta clé, qui ne sort jamais de l'anneau.

| Fichier ([`brand/`](../brand/)) | Usage |
|---|---|
| `kyro-mark-dark.svg` | symbole sur fond sombre — **usage principal** |
| `kyro-mark.svg` | symbole sur fond clair (README GitHub, documentation) |
| `kyro-icon.svg` | icône d'application 1024 px (fond sombre) — **par défaut** |
| `kyro-icon-blue.svg` | icône d'application, variante bleu foncé |
| `kyro-logo-dark.svg` | symbole + « kyro wallet », fond sombre |
| `kyro-logo.svg` | symbole + « kyro wallet », fond clair |

Les logos complets utilisent la police Geist pour le texte : à vectoriser avant un usage hors de l'application.

## Couleurs (tokens)

| Token | Valeur | Rôle |
|---|---|---|
| `bg` | `#0A0B0D` | fond de fenêtre |
| `bgDeep` | `#08090B` | barre d'état |
| `card` | `#121418` | cartes |
| `cardHero` | `#101215` | grande carte du solde, graphiques |
| `raised` | `#16181C` | champs, lignes en relief |
| `control` | `#1D1F24` / `#22252B` | boutons secondaires, sélection d'onglet |
| `line` | `#1E2228` / `#292E35` / `#353B44` | filets et bordures (trois intensités) |
| `text` | `#F5F7FA` | texte principal |
| `text2` | `#C8CDD6` | texte de liste |
| `mute` | `#8C929D` | texte secondaire |
| `faint` | `#5E6470` | décimales, libellés discrets |
| `primary` | `#E4ECF3` | blanc givré : action principale (texte `onPrimary` `#08090B`) |
| `ice` | `#7CC4FF` | bleu givre : sélection, courbes, à vérifier |
| `iceSoft` | `rgba(124,196,255,.08–.16)` | fonds bleu givre |
| `iceText` | `#CDE9FF` / `#A9D8FF` | texte sur fond bleu givre |
| `up` | `#3DDC97` | hausse, succès |
| `down` | `#FF6B6B` | baisse, danger |
| `warn` | `#F5B74F` | avertissement, testnet |

Couleurs des réseaux (pastilles, répartition) : Bitcoin `#F7931A`, Ethereum `#627EEA`, Solana `#35D0BA`, USD Coin `#2F8BE6`, Arbitrum `#9FD8FF`.

## Frais personnalisables

Chaque envoi propose **Lent / Normal / Rapide / Personnalisé**. En mode personnalisé, l'utilisateur saisit lui-même :
- EVM : *frais max. par gas* et *pourboire prioritaire* (gwei) ;
- Bitcoin : *sat/vB* (et RBF pour accélérer plus tard) ;
- Solana : *priority fee* (micro-lamports).

Le coût en crypto et en euros, et le délai estimé se recalculent en direct ; un avertissement s'affiche si les frais sont sous le minimum du réseau.

## Typographie

- **Geist** (400, 500, 560) : interface. Titres d'écran à 30 px (−0,038 em), grands montants à 56–76 px en graisse 480, chiffres tabulaires, décimales en `faint`.
- **Libellés** (`.eyebrow`, Geist 12 px, 500, `mute`) : libellés de section et de champ, en-têtes de tableau, en minuscules comme une phrase. Pas de capitales espacées, pas de mono décoratif.
- **Geist Mono** (400, 500) : adresses, barre d'état, heures.
- Les deux polices (licence OFL) seront **embarquées dans l'app** : aucun appel à Google Fonts en production (CSP).

## Formes

- Trois rayons seulement : surfaces 10 px (`rounded-panel`), boîtes 7 px (`rounded-box`), contrôles 6 px (`rounded-ctl`). Pas de pilules, sauf pastilles et interrupteurs.
- Badges en **étiquettes** (cadre fin, texte normal) ; seuls les états qui demandent l'attention ont une couleur.
- Avertissements : filet gauche de la couleur du ton (ambre, rouge), jamais atténués.
- Pas de halo ni de dégradé décoratif ; une ombre seulement sous les dialogues et menus.
- **Rien de décoratif « façon IA »** : pas de slogans, pas de numérotation 01/02/03 sur des choix, pas de faux instruments (cadrans, graduations), pas de mentions techniques en accroche (algorithmes, licence, « zéro télémétrie ») hors des écrans qui les expliquent. Accueil : le logo, le nom, trois choix.
- Graphiques : courbe lissée bleu givre 1,75 px, voile givre de 16 % à 0 %, point de survol cerclé avec infobulle.

## Mouvement

- Rapide (150–350 ms), **en entrée seulement** : rien ne retarde un clic ni une navigation.
- Écrans : fondu + glissé de 8 px. Listes : entrée échelonnée (`.stagger`, `--i`). Courbes : tracées de gauche à droite. Soldes : compteur (`useTicker`).
- Indicateurs glissants (`layoutId`) : rail, onglets, `Segmented`, sections des Réglages, réseau de Recevoir.
- Dialogues et menus : entrée ressort, sortie courte. Boutons : légère pression.
- `prefers-reduced-motion` : tout est coupé (`MotionConfig reducedMotion="user"` + règle CSS), seules les roues de chargement tournent, lentement.

## Composants signature

- **Solde + graphique pleine largeur** sur le Portefeuille, hors carte, avec actions Envoyer / Recevoir / Swap.
- **Panneau de marque** (logo et nom, rien d'autre) sur l'écran de bienvenue.
- **Adresse en blocs** : `0x4F2a 9C83 … 6c19 D7b2`, deux premiers et deux derniers blocs sur fond bleu givre.
- **Encadré « En clair »** : étiquette bleu givre + une phrase.
- **Carte Coffre** : état du verrou, compte à rebours, hardware wallet, autorisations illimitées.
- **Autorisations actives** dans l'Historique, avec bouton Révoquer.

## Accessibilité

- Cibles cliquables ≥ 40 px dans le contenu, 44–60 px dans le rail.
- Contrastes texte ≥ 4,5:1 (`mute` sur `card` ≈ 6:1).
- Hausse et baisse toujours accompagnées d'une flèche ou d'un signe.
