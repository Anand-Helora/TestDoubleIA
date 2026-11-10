# TestDoubleIA
projet test pour double utilisation ia 

## Jeu Snake

Jeu Snake jouable dans le navigateur, sans installation ni dépendance externe.

### Lancer le jeu

Ouvrir `index.html` dans un navigateur (double-clic, fonctionne aussi en `file://`).

### Commandes

| Action | Touches |
| --- | --- |
| Déplacer | Flèches, ZQSD (AZERTY), WASD (QWERTY) ou croix directionnelle tactile sous le plateau |
| Pause / reprise | Espace, ou bouton « Pause » / « Reprendre » sous le plateau (souris, tactile, clavier) |
| Recommencer après une partie | Entrée ou bouton « Recommencer » |

La partie démarre à la première touche de direction (clavier ou croix tactile).

### Règles

- Chaque pomme mangée rapporte 1 point et allonge le serpent d'une case.
- Les pommes apparaissent uniquement sur des cases libres.
- Toucher un mur ou son propre corps termine la partie (« Partie terminée »).
- Le demi-tour immédiat est impossible, y compris avec deux touches pressées très vite.
- Si le serpent remplit toute la grille, la partie est gagnée.
- Le bouton « Pause » est désactivé avant le premier déplacement et en fin de partie. Il partage
  l'état de la touche Espace et de la pause automatique au changement d'onglet : un seul état de pause,
  un seul minuteur.
- La croix directionnelle (boutons « Haut », « Bas », « Gauche », « Droite », cibles de 52 px) suit
  exactement les règles du clavier : même file de directions (demi-tour refusé), même minuteur unique.
  Elle est désactivée en pause et en fin de partie. Un clic souris ne lui donne pas le focus, pour
  qu'Espace continue de mettre en pause ; au clavier (Tab), Espace / Entrée activent le bouton focalisé.
- Le meilleur score (« Record ») s'affiche à côté du score, se met à jour dès qu'il est dépassé
  et est conservé entre les sessions dans le `localStorage` du navigateur (clé `snake.bestScore`).
  Si le stockage est indisponible, bloqué ou contient une valeur invalide, le jeu reste jouable
  et le record repart de 0 (il est alors gardé en mémoire pendant la session).

### Structure

| Fichier | Rôle |
| --- | --- |
| `index.html` | Page du jeu |
| `style.css` | Mise en forme |
| `snake.js` | Logique pure (déplacement, collisions, pommes, score), sans DOM |
| `best-score.js` | Meilleur score : lecture/écriture protégées dans `localStorage`, validation des valeurs |
| `game.js` | Rendu canvas, clavier, croix tactile, boucle de jeu, écran de fin |
| `tests/snake.test.js` | Tests unitaires de la logique |
| `tests/best-score.test.js` | Tests du meilleur score (validation, persistance simulée, erreurs de stockage) |
| `tests/game.test.js` | Tests de l'interface `game.js` avec DOM et minuteurs simulés |
| `tests/browser_check.py` | Test de bout en bout déterministe dans un vrai navigateur (facultatif) |
| `.github/workflows/tests.yml` | Exécution automatique des tests (GitHub Actions) |

### Tests

```bash
# Tests unitaires et d'interface (Node.js 18+, aucune dépendance)
node --test

# Test navigateur de bout en bout (facultatif)
pip install playwright && playwright install chromium
python3 tests/browser_check.py --runs 5          # options : --browser firefox|webkit, --screenshot f.png
```

### Intégration continue

Le workflow `.github/workflows/tests.yml` s'exécute sur chaque pull request vers `main` (et manuellement) :
`node --test` sous Node 22, puis `tests/browser_check.py --runs 5` dans Chromium, Firefox et WebKit.
Les journaux, captures et le rapport JUnit sont publiés comme artefacts.

Le crochet de test `window.__snake` n'est exposé qu'en ouvrant `index.html?test`.

## Automatisation multi-IA

- `.github/workflows/codex-feedback-dryrun.yml` : détection **en lecture seule** des anomalies signalées
  par Codex sur les PR ouvertes (Issue #5, phase A). Aucune correction automatique, aucun secret,
  aucune permission d'écriture. Voir [docs/codex-feedback-dryrun.md](docs/codex-feedback-dryrun.md).
- `.github/workflows/codex-feedback-gate.yml` : passerelle de décision Codex → Claude (Issue #9,
  phase B1). Elle applique les garde-fous (même dépôt, branche `claude/*`, auteur autorisé, émetteur Codex),
  la déduplication persistante (refs Git `refs/codex-gate/v1/**` créées de façon atomique) et les limites
  (1 tentative par SHA, 2 cycles par PR). **Aucun appel à Claude, aucun secret, aucune fusion** ; la
  réservation reste désactivée tant que la variable `CODEX_GATE_ENABLED` ne vaut pas `true`. Voir
  [docs/codex-feedback-gate.md](docs/codex-feedback-gate.md).
