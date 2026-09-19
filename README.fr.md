# ClaudeTerm

*[English version](README.md)*

Poste de travail macOS natif pour piloter [Claude Code](https://claude.com/claude-code) sur plusieurs projets.
Terminal natif (SwiftTerm), un onglet par projet, et des panneaux qui lisent ce que Claude Code écrit déjà
sur disque (transcripts, plans, réglages) sans rien lui demander.

macOS 14+, Apple Silicon. Aucune dépendance externe hormis `claude` dans le PATH.
Interface en français ou en anglais (ClaudeTerm › Réglages…).

![ClaudeTerm](docs/screenshot.png)

*ClaudeTerm en mode sombre : Finder du projet et dossiers liés à gauche, terminal et bloc session au centre, panneaux globaux à droite.*

## Build

Sans Xcode, seulement les Command Line Tools :

```
./build.sh        # swift build -c release + bundle ClaudeTerm.app (signé ad hoc)
open ClaudeTerm.app
./test.sh         # tests unitaires (Swift Testing)
```

Pour un autre Mac : zipper `ClaudeTerm.app`, puis retirer la quarantaine (`xattr -d com.apple.quarantine`).

## Organisation de la fenêtre

```
┌ barre de titre : [◧] (projet A) (projet B) (+)                       [◨] ┐
├──────────────┬────────────────────────────────────────┬──────────────────┤
│ Finder du    │ onglets terminal : shell · claude · dev │ Process          │
│ projet       │ ┌────────────────────────────────────┐ │ Historique       │
│              │ │ terminal natif                      │ │ Skills           │
│              │ └────────────────────────────────────┘ │ Réglages         │
│ ─────────── │ dossier · mode · tokens · état          │                  │
│ 🔗 📦 ✨  ⓘ ˅ │ ─────────────────────────────────────── │                  │
│ liés/scripts/│ 📋 📈 📄  session   ⓘ ˅                  │                  │
│ skills       │ plan / activité / fichiers              │                  │
└──────────────┴────────────────────────────────────────┴──────────────────┘
```

**Gauche = le projet, centre = la session, droite = global.**

### Projets (barre de titre)
Un onglet par dossier ouvert. `+` ouvre un projet vierge avec l'écran d'accueil (dossier, récents).
Les projets ouverts sont restaurés au lancement, pas leurs terminaux.
⌘N nouveau projet · ⌘O ouvrir un dossier · ⇧⌘W fermer · ⌥⌘[ ] changer de projet.

### Colonne gauche
- **Finder** borné à la racine du projet. Double-clic : entrer dans un dossier / ouvrir un fichier.
  Flèches retour et parent. Espace : Quick Look. Glisser un fichier sur le terminal tape son chemin.
  Clic droit : Claude ici, shell ici, insérer le chemin, ouvrir comme projet.
- **Bloc du bas**, trois modes (icônes à gauche, ⓘ explique le mode, chevron replie) :
  - 🔗 **Dossiers liés** : les projets dont celui-ci dépend. Voir *Projets liés*.
  - 📦 **Scripts npm** : scripts du `package.json` (workspaces et dossiers liés inclus), lancés dans un
    onglet réutilisé. Gestionnaire déduit du lockfile.
  - ✨ **Skills du projet** : `.claude/skills/*/SKILL.md` et `.claude/commands/*.md`. Voir *Skills*.
  - ⛓ **MCP du projet** : serveurs de `.mcp.json` (et des dossiers liés). Ajout, édition, copie depuis
    un autre projet. Voir *MCP*.

### Centre
- Onglets terminal : `+` / ⌘T shell, ⇧⌘T Claude, ⌘W fermer, ⇧⌘[ ] naviguer.
- Icône verte = commande en cours, rouge = dernier script en échec, étincelle = Claude.
- Taper `claude` dans un shell suffit : l'onglet passe en mode Claude (plan, activité…).
- Images pour Claude : glisser-déposer un fichier ou une image, ⌥⌘S capture d'écran, ⌘V d'une image.
  Tout devient un fichier dont le chemin est tapé dans le prompt.
- Barre de statut : dossier, mode de permission, plan, tokens, état du process.
- **Bloc session** sous le terminal, même motif que la colonne gauche (⌥⌘3 replie) :
  - 📋 **Plan** : le plan du mode plan, rendu markdown, progression ; s'ouvre seul quand Claude entre en mode plan.
  - 📈 **Activité** : flux du transcript (messages, outils, fichiers), tokens.
  - 📄 **Fichiers** : fichiers touchés par la session, avec le diff exact de ce que Claude a changé.
    L'état « avant » vient des sauvegardes que Claude Code garde lui-même
    (`~/.claude/file-history/<session>`), donc le diff est par session, indépendant de git.
    Un fichier créé par Claude est comparé au vide.

### Panneau droit
- **Process** : tous les process `claude` du Mac, leurs sous-process, outils en cours. Stop au survol.
- **Historique** : sessions du projet ou de tous les projets, recherche, reprise (`--resume`), corbeille.
- **Skills** : skills perso (`~/.claude/skills`) et plugins.
- **MCP** : serveurs perso et locaux (`~/.claude.json`), connecteurs claude.ai et plugins avec leur état
  (`claude mcp list`, sur demande). Ajout/suppression via `claude mcp add|remove`.
- **Réglages** : formulaire pour `~/.claude/settings.json` (modèle, permissions, hooks, env, plugins)
  et police du terminal. Les clés inconnues sont préservées.

## Projets liés

Le problème : front, API et design system sont des dépôts séparés, et il faut sans cesse dire à Claude
« va voir dans tel dossier ». La solution s'appuie sur des mécanismes natifs de Claude Code :

- `.claude/settings.local.json` du projet reçoit les chemins dans `permissions.additionalDirectories`
  (accès direct) et, pour un lien en lecture seule, des règles `deny` sur Edit/Write
  (syntaxe `//chemin/**` : un seul `/` serait relatif au projet).
- `.claude/claudeterm.json` garde les rôles (« api », « design system »).
- `.claude/claudeterm-prompt.txt` décrit les liens ; il est passé via `--append-system-prompt-file`
  par les onglets Claude et par la fonction `claude` du shell intégré.

## Skills

Un skill = un dossier `.claude/skills/<nom>/SKILL.md` : frontmatter `name` / `description`, puis les
instructions. Claude le charge seul quand la description correspond, ou via `/nom`.
Trois modes affichés : auto + `/` (défaut), manuel seulement (`disable-model-invocation: true`),
auto seulement (`user-invocable: false`). Création (vide ou rédigée par Claude), import d'un `.md` ou
d'un dossier, glisser-déposer, édition dans une feuille, copie projet ↔ perso.

## MCP

Trois portées chez Claude Code : **projet** (`.mcp.json` à la racine, partagé), **local** (privé, par
projet, dans `~/.claude.json`) et **perso** (`~/.claude.json`). Le `.mcp.json` est écrit directement
(clé `mcpServers`, le reste préservé) ; les portées local et perso passent par la CLI `claude mcp`
pour ne pas réécrire `~/.claude.json`. L'état (connecté, auth requise, échec) vient de
`claude mcp list`, lent, donc déclenché par un bouton. « /mcp » envoie la commande à l'onglet Claude
pour s'authentifier.

## Localisation

Les textes sources sont en français ; `Resources/en.lproj/Localizable.strings` porte la table anglaise,
copiée dans le bundle par `build.sh`. Le choix de langue dans Réglages écrit `AppleLanguages` dans les
préférences de l'app et relance.

## Notifications

Réglages › Notifications › « Installer les hooks Claude Code » ajoute deux entrées (`Notification`,
`Stop`) dans `~/.claude/settings.json` vers `~/Library/Application Support/ClaudeTerm/hook.sh`. Le
script dépose le JSON du hook dans un dossier d'événements que ClaudeTerm surveille. Chaque événement
est rattaché à l'onglet par chemin de transcript, sinon par dossier, et signalé par un point sur
l'onglet, un compteur sur le projet, un badge sur l'icône du Dock et, si l'onglet n'est pas visible,
une notification macOS qui ramène à l'onglet au clic. Permission en attente (orange), session inactive
(jaune), réponse terminée (bleu). Effacé quand l'onglet est affiché ou que la session repart.

## Intégration shell

Les onglets shell reçoivent un `ZDOTDIR` privé (`~/Library/Application Support/ClaudeTerm/zsh`) dont
les rc chargent tes fichiers zsh puis ajoutent des hooks `preexec`/`precmd`. Ils émettent une séquence
OSC 7770 (début/fin de commande + code de sortie) et OSC 7 (dossier courant). Aucun sondage : l'état
des onglets, la réutilisation d'un shell libre et le dossier courant viennent de là.
Le shell est toujours zsh.

## Ce que ClaudeTerm lit et écrit

| Chemin | Rôle |
|---|---|
| `~/.claude/projects/<chemin encodé>/*.jsonl` | transcripts (lecture ; corbeille depuis l'Historique) |
| `~/.claude/projects/<…>/sessions-index.json` | titres, dates, branche (lecture ; nettoyé à la suppression) |
| `~/.claude/plans/*.md` | plans (lecture) |
| `~/.claude/file-history/<session>/` | sauvegardes avant modification, pour le diff de session (lecture) |
| `~/.claude/settings.json` | réglages globaux (formulaire) |
| `<projet>/.claude/settings.local.json` | dossiers liés, lecture seule |
| `<projet>/.claude/claudeterm.json`, `claudeterm-prompt.txt` | rôles des liens, prompt système |
| `<projet>/.mcp.json` | serveurs MCP du projet (écriture ciblée) |
| `~/.claude.json` | serveurs MCP perso/locaux (lecture seule ; écriture via `claude mcp`) |
| `~/Library/Application Support/ClaudeTerm/` | drops d'images, rc zsh |

Le chemin encodé suit la règle de Claude Code : tout caractère hors `[a-zA-Z0-9]` devient `-`.

## Code

```
Sources/ClaudeTerm/
  App.swift            fenêtre, barre de projets, accueil, raccourcis
  Models.swift         TerminalSession (pty, transcript, shell events), Project, AppState
  TerminalViews.swift  zone centrale : onglets, hôte SwiftTerm, barre de statut
  FileBrowserView.swift Finder, bloc du bas (liens / scripts / skills), cache de listings
  ToolsPanel.swift     panneau droit : Process, Historique, Plan (markdown), Activité, Fichiers
  SettingsView.swift   formulaire settings.json (SettingsModel)
  ClaudeData.swift     lecture des transcripts, index, plans
  Links.swift          projets liés (LinkStore) et éditeur de rôles
  Scripts.swift        package.json, scripts, workspaces
  Skills.swift         SkillStore, listes, feuilles création / édition / import
  MCP.swift            MCPStore (.mcp.json, ~/.claude.json, claude mcp), panneaux, feuille d'édition
  ProcessMonitor.swift ps + lsof
  ShellIntegration.swift  rc zsh + fonction claude
  Attachments.swift    drop / capture / collage d'images
  Theme.swift          couleurs du terminal selon l'apparence
  QuickLook.swift      panneau Quick Look
Tests/ClaudeTermTests/ tests des parties pures (parsing, LinkStore, SettingsModel, skills, npm)
```

Points d'attention connus : le rattachement process ↔ onglet se fait par dossier et heure de démarrage ;
le format des transcripts et de l'index n'est pas documenté par Claude Code et peut changer.

## Licence

PolyForm Noncommercial 1.0.0. Utilisation, modification et partage libres pour un usage personnel,
éducatif, de recherche ou associatif ; tout usage commercial demande l'accord de l'auteur.
Voir [LICENSE.md](LICENSE.md).

Required Notice: Copyright Jérôme Laval.
