# TestDoubleIA
projet test pour double utilisation ia 

## Jeu Snake

Jeu Snake jouable dans le navigateur, sans installation ni dépendance externe.

### Lancer le jeu

Ouvrir `index.html` dans un navigateur (double-clic, fonctionne aussi en `file://`).

### Commandes

| Action | Touches |
| --- | --- |
| Déplacer | Flèches, ZQSD (AZERTY) ou WASD (QWERTY) |
| Pause / reprise | Espace |
| Recommencer après une partie | Entrée ou bouton « Recommencer » |

La partie démarre à la première touche de direction.

### Règles

- Chaque pomme mangée rapporte 1 point et allonge le serpent d'une case.
- Les pommes apparaissent uniquement sur des cases libres.
- Toucher un mur ou son propre corps termine la partie (« Partie terminée »).
- Le demi-tour immédiat est impossible, y compris avec deux touches pressées très vite.
- Si le serpent remplit toute la grille, la partie est gagnée.

### Structure

| Fichier | Rôle |
| --- | --- |
| `index.html` | Page du jeu |
| `style.css` | Mise en forme |
| `snake.js` | Logique pure (déplacement, collisions, pommes, score), sans DOM |
| `game.js` | Rendu canvas, clavier, boucle de jeu, écran de fin |
| `tests/snake.test.js` | Tests unitaires de la logique |
| `tests/game.test.js` | Tests de l'interface `game.js` avec DOM et minuteurs simulés |
| `tests/browser_check.py` | Test de bout en bout déterministe dans un vrai navigateur (facultatif) |

### Tests

```bash
# Tests unitaires et d'interface (Node.js 18+, aucune dépendance)
node --test

# Test navigateur de bout en bout (facultatif)
pip install playwright && playwright install chromium
python3 tests/browser_check.py --runs 5          # options : --browser firefox|webkit, --screenshot f.png
```

Le crochet de test `window.__snake` n'est exposé qu'en ouvrant `index.html?test`.
