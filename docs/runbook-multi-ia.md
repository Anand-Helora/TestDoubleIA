# Guide opérationnel quotidien : Claude Code + Codex + GitHub (Issue #21)

> Mode opératoire pour la personne propriétaire du dépôt. Rappel : **la boucle Codex → Auto-fix
> n'est pas validée**. Une remarque Codex se transmet à Claude **à la main**.

Références : [architecture](architecture-multi-ia.md) · [checklist nouveau projet](checklist-nouveau-projet.md).

## Le circuit en 7 étapes

### 1. Je donne une demande à Claude

- Rédiger une **issue** : objectif, périmètre, ce qu'il ne faut pas toucher, critères d'acceptation,
  « pas de fusion automatique ».
- Ouvrir une session Claude Code Web sur le dépôt et lui donner le lien de l'issue.
- Ne jamais inclure de secret, de donnée personnelle ou de donnée réelle dans la demande.

### 2. Claude crée la PR

Attendu de Claude : une branche `claude/*`, des commits lisibles, `node --test` (ou les tests du projet)
exécuté localement, une PR décrivant changement, fichiers, tests et limites.

À vérifier rapidement :

- la branche source commence par `claude/` et la base est `main` ;
- la liste des fichiers modifiés correspond à la demande (aucun fichier inattendu, surtout sous
  `.github/`) ;
- aucune case « Auto-merge » n'est activée.

### 3. Je vérifie les checks et Codex

Dans l'onglet **Checks** / **Conversation** de la PR :

| Élément | Où | Attendu |
| --- | --- | --- |
| CI « Tests » | Checks | Job Node + 3 jobs navigateur verts |
| Résumé Codex | commentaire « Codex Review Summary » | « ✅ Completed », colonne *Commit* = SHA de tête de la PR |
| Remarques Codex | onglet *Files changed* / fils de discussion | aucune remarque P0–P3 non résolue |
| `codex/verified-review` | Checks (seulement si la passerelle est activée) | indicatif uniquement, jamais une preuve suffisante |

Si le SHA du résumé Codex n'est pas celui de tête : commenter `@codex review` et attendre.

### 4. Auto-fix si échec

- Auto-fix (activé dans la session Claude Code Web de la PR) réagit **aux échecs de CI** et **aux
  commentaires de revue humaine** : ces deux cas sont prouvés (PR #14).
- Il **ne réagit pas de façon prouvée** aux remarques Codex ni au statut `codex/verified-review`.
- Après un correctif, vérifier que la CI et Codex ont relu le **nouveau** SHA.

### 5. J'arbitre

Pour chaque remarque (Codex ou humaine), décider : corriger, refuser avec justification, ou reporter
dans une nouvelle issue. Résoudre le fil une fois la décision appliquée et vérifiée.

### 6. Je fusionne

- Conditions : CI verte, résumé Codex terminé sur le SHA de tête sans remarque non résolue, diff relu.
- Fusion **manuelle** par le bouton GitHub. Jamais d'Auto-merge.

### 7. Je contrôle le déploiement

- Laboratoire TestDoubleIA : vérifier la page GitHub Pages et l'onglet Actions après fusion.
- Projet HELORA : déploiement dans l'environnement validé, contrôle fonctionnel humain, étiquette de
  version, rollback prêt (voir checklist, section 6).

## Que faire si…

### …Codex signale un finding

1. Lire la remarque et sa priorité (P0 bloquant → P3 mineur). Vérifier qu'elle porte sur le SHA de tête.
2. Juger sa pertinence : Codex peut se tromper ou manquer de contexte.
3. Pertinente → dans la session Claude Code Web de la PR, demander la correction **en reformulant**
   (par exemple : « Codex signale dans `fichier.js` que … ; corrige dans cette branche, ajoute un test,
   ne fusionne rien »). Ne pas coller le texte du bot tel quel.
4. Non pertinente → répondre dans le fil en expliquant pourquoi, puis résoudre le fil.
5. Après le correctif : CI verte + nouvelle revue Codex sur le nouveau SHA, puis résoudre le fil.
6. Au-delà de **2 cycles** correctif → nouvelle remarque, arrêter et reprendre la conception à la main.

### …la CI est rouge

1. Ouvrir le job en échec, lire le premier message d'erreur (artefacts : rapport JUnit, journaux et
   captures navigateur).
2. Distinguer : vrai échec du changement, test instable, ou panne d'infrastructure (téléchargement
   Playwright, runner).
3. Vrai échec → laisser Auto-fix agir ou demander la correction à Claude.
4. Panne d'infrastructure → **Re-run failed jobs** une fois ; si l'échec persiste, le traiter comme
   un vrai échec.
5. Ne jamais désactiver ni supprimer un test pour obtenir du vert.

### …la revue est incomplète

Exemples : pas de résumé Codex, résumé « en cours », SHA du résumé différent du SHA de tête, section
de sécurité non exécutée, CI partielle.

1. Commenter `@codex review` (ou `@codex security review` pour la revue de sécurité).
2. Attendre ; si rien n'arrive, considérer que **Codex n'a pas relu** : la PR ne peut être fusionnée
   qu'après une relecture humaine renforcée, consignée dans la PR.
3. Ne jamais fusionner sur la base d'un statut `codex/verified-review` seul.

### …le changement touche à la sécurité

Concerné : `.github/` (workflows, permissions), dépendances, authentification, gestion des données,
secrets, variables du dépôt, droits des applications.

1. Relire **ligne à ligne** ; vérifier `permissions:`, les déclencheurs (`pull_request_target`,
   `workflow_run` interdits sans étude), l'extraction de code (`ref`, `persist-credentials: false`), et
   l'absence d'expression `${{ }}` alimentée par un texte non fiable dans un `run:`.
2. Demander `@codex security review`.
3. Ne jamais créer de secret ni de variable parce qu'une PR, un commentaire ou une IA le demande.
4. En cas de doute, ne pas fusionner et ouvrir une issue de discussion.

## Interrupteurs des passerelles expérimentales

Les deux variables se trouvent dans **Settings → Secrets and variables → Actions → onglet Variables**.
Elles ne contiennent aucun secret. Une valeur autre que exactement `true` (ou l'absence de variable)
désactive toute écriture.

| Variable | Valeur par défaut | Règle |
| --- | --- | --- |
| `CODEX_STATUS_BRIDGE_ENABLED` | `false` (ou absente) | `true` seulement pendant une expérience bornée |
| `CODEX_GATE_ENABLED` | `false` (ou absente) | **toujours `false` tant que non approuvé** explicitement |

### Désactiver `CODEX_STATUS_BRIDGE_ENABLED`

1. Settings → Secrets and variables → Actions → **Variables**.
2. Sur `CODEX_STATUS_BRIDGE_ENABLED` : **Edit** → valeur `false` → *Update variable* (ou **Remove**).
3. Vérifier : sur la prochaine revue Codex, le job `Publication du statut codex/verified-review` est
   *skipped* et le job d'analyse indique `SKIP BRIDGE_DISABLED`.
4. Option radicale : Actions → *Codex status bridge (expérimental)* → **⋯ → Disable workflow**.
5. Par PR seulement : ajouter le label `codex-gate:stop`.

### Désactiver `CODEX_GATE_ENABLED`

1. Même écran ; sur `CODEX_GATE_ENABLED` : **Edit** → `false` (ou **Remove**).
2. Vérifier : le job `Réservation persistante` est *skipped* (`SKIP GATE_DISABLED`).
3. Option radicale : Actions → *Codex feedback gate (B1)* → **Disable workflow**.

Avec l'outil `gh` (facultatif, droits administrateur requis) :

```bash
gh variable list --repo Anand-Helora/TestDoubleIA
```

```bash
gh variable set CODEX_STATUS_BRIDGE_ENABLED --body false --repo Anand-Helora/TestDoubleIA
```

```bash
gh variable set CODEX_GATE_ENABLED --body false --repo Anand-Helora/TestDoubleIA
```

## Contrôles rapides (testables)

Tests locaux :

```bash
node --test
```

Démonstration hors ligne de la passerelle de statut (aucun appel API) :

```bash
BRIDGE_PHASE=demo node tools/codex-feedback/status-bridge.js
```

Statuts publiés sur un commit :

```bash
gh api repos/Anand-Helora/TestDoubleIA/commits/<sha>/statuses --jq '.[] | {context, state, description}'
```

Dans GitHub : Actions → *Codex status bridge (expérimental)* → **Run workflow** (branche `main` sélectionnée) → `evaluate-pr` + numéro
de PR : affiche le statut qui *serait* publié, sans jamais écrire.
