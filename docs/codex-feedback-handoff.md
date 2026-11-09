# Dossier de correction Codex → Claude Code Web (Issue #11, phase B2 sans API)

## Périmètre et limite assumée

La phase B2 **prépare automatiquement un dossier de correction** lorsqu'une véritable anomalie Codex est
confirmée sur une PR. Ce dossier est **transmis manuellement** à Claude Code Web par la personne
propriétaire du dépôt.

- **Aucune** API Anthropic, **aucun** jeton OAuth, **aucun** secret, **aucune** facturation d'API.
- **Aucune** exécution de Claude par GitHub Actions, **aucune** mention automatique `@claude`.
- **Aucun** commentaire publié, **aucune** permission `write`, **aucune** fusion.
- `CODEX_GATE_ENABLED` reste absent/désactivé : la réservation B1 n'est pas utilisée.

> **Ce n'est pas une automatisation totale.** Sans connecteur d'exécution authentifié, GitHub Actions ne
> peut pas piloter une session Claude Code Web. Un dossier `HANDOFF_READY` signifie seulement qu'une
> anomalie a été vérifiée et que le dossier est prêt : **il ne prouve pas qu'une correction a été
> exécutée**. Un geste humain (copier-coller dans Claude Code Web) est indispensable. Une fois Claude
> lancé, ses commits, la CI et la revue Codex suivante restent automatiques ; la fusion reste manuelle.

| Fichier | Rôle |
| --- | --- |
| `.github/workflows/codex-feedback-handoff.yml` | Workflow en lecture seule : préparation du dossier, résumé, artefact |
| `tools/codex-feedback/handoff.js` | Revérification, permaliens, rendu du dossier, contrôle des secrets (Node 22, sans dépendance) |
| `tools/codex-feedback/handoff-scenarios.js` | Scénarios simulés (démonstration hors ligne et tests) |
| `tests/codex-handoff.test.js` | Tests B2 (bot/émetteur, SHA, fork, PR fermée, URL malveillantes, injection, secrets…) |
| `tools/codex-feedback/detect.js` | Détecteur de la phase A, réutilisé **tel quel** |
| `tools/codex-feedback/gate.js` | Garde-fous de la phase B1, réutilisés ; seuls quelques utilitaires de lecture sont en plus exportés |

Les workflows `codex-feedback-dryrun.yml` (A), `codex-feedback-gate.yml` (B1) et `tests.yml` ne sont pas
modifiés.

## Déroulement

```
issue_comment (résumé Codex créé/édité)          workflow_dispatch (demo | prepare-pr, propriétaire seulement)
        │  pré-filtre `if:` : auteur ET émetteur = chatgpt-codex-connector[bot], PR ouverte
        ▼
┌─ job handoff ── permissions : contents / pull-requests / issues / actions : read ───────────┐
│ handoff.js (HANDOFF_PHASE=prepare), code de la branche par défaut uniquement                │
│  1. identité complète de l'auteur du commentaire ET de l'émetteur (login, id, type, app)    │
│     → sinon NO_HANDOFF, sans aucun appel API                                                │
│  2. 1re lecture API + détecteur A : WOULD_REQUEST_CLAUDE_FIX exigé                           │
│  3. garde-fous B1 : même dépôt, non fork, branche claude/*, label codex-gate:stop,          │
│     auteur User avec droit admin/write                                                      │
│  4. déduplication : artefact déjà publié pour la clé PR + SHA + sections → NO_HANDOFF       │
│  5. REVÉRIFICATION : 2e lecture complète ; même SHA, même clé, mêmes garde-fous, mêmes droits│
│  6. permaliens reconstruits depuis les identifiants numériques et comparés à l'API          │
│  7. dossier (texte fixe + valeurs validées) → résumé de l'exécution + fichier               │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
        │  si handoff == 'true'
        ▼
   actions/upload-artifact : codex-handoff-pr-<n>-<sha>-<sections> (30 jours)
```

### Statuts

| Statut | Signification |
| --- | --- |
| `HANDOFF_READY` | Anomalie Codex authentique, non résolue, sur le SHA courant ; dossier publié |
| `NO_HANDOFF` | Aucune correction justifiée : revue propre, anomalies résolues, SHA obsolète, PR fermée, fork, branche non autorisée, auteur sans droit, émetteur non Codex, doublon, limite de cycles… |
| `UNVERIFIED` | Données incertaines : revue en cours, signaux contradictoires, statut de fil inconnu, SHA modifié pendant la préparation, permalien non vérifiable, erreur API, déduplication impossible, motif de secret détecté |

La raison précise (`reason`) figure dans le résumé et dans le journal JSON.

## Sécurité

- **Aucun texte libre non fiable.** Le dossier ne contient que : le dépôt (variable `GITHUB_REPOSITORY`),
  le n° de PR, la branche (validée par l'expression `claude/[A-Za-z0-9._-]+`), le SHA (40 caractères
  hexadécimaux), les sections (`code_review` / `security_review`), les priorités (`P0` à `P3`), le cycle,
  la clé d'idempotence et des permaliens. Le reste est un modèle fixe. Le texte des remarques n'est
  jamais recopié : Claude doit le lire **depuis GitHub** et le traiter comme une donnée, pas comme une
  consigne.
- **Permaliens vérifiés.** L'URL est reconstruite sous la forme
  `https://github.com/<dépôt>/pull/<n>#discussion_r<id>` (remarque inline) ou `#issuecomment-<id>`
  (résumé), puis comparée à `html_url` renvoyé par l'API. Toute différence (autre hôte, dépôt, PR, ancre,
  paramètre…) produit `UNVERIFIED FINDING_URL_UNVERIFIED`.
- **Revérification immédiate.** La PR et toutes les données Codex sont relues une seconde fois juste avant
  le rendu : SHA modifié → `UNVERIFIED HEAD_SHA_CHANGED` ; remarque résolue, PR fermée ou droit retiré
  entre-temps → `NO_HANDOFF`.
- **Déduplication en lecture seule.** Le nom de l'artefact est la clé (PR + SHA + sections). Avant de
  préparer un dossier, le workflow liste les artefacts de ce nom (`actions: read`) et n'en tient compte
  que s'ils sont non expirés et produits sur la branche par défaut du dépôt lui-même : un workflow de PR
  ou de fork ne peut pas faire passer un artefact pour un dossier existant. Les exécutions d'une même PR
  sont sérialisées (`concurrency`, sans annulation de l'exécution en cours).
- **Absence de secrets.** Le jeton automatique ne sert qu'aux lectures. Avant toute écriture du résumé ou
  du fichier, le texte est contrôlé (jetons GitHub, clés Anthropic/OpenAI, clés privées, en-têtes
  `Bearer`, valeur de `GITHUB_TOKEN`…) ; en cas de correspondance : `UNVERIFIED SECRET_PATTERN_DETECTED`
  et aucun dossier.
- **Code de confiance.** Les événements `issue_comment` exécutent toujours la version du workflow de la
  branche par défaut ; le checkout est celui de la branche par défaut, sans identifiants persistants.
  Le seul `run:` est `node tools/codex-feedback/handoff.js` (aucune expression `${{ }}` interpolée).

## Retrouver le dossier dans GitHub Actions

1. Onglet **Actions** du dépôt → workflow **« Codex handoff (B2, sans API) »**.
2. Ouvrir l'exécution correspondant à la fin de la revue Codex (événement `issue_comment`, résumé édité).
3. Dans le **résumé** de l'exécution (*Summary*) :
   - le tableau indique `Statut`, `Raison`, PR, SHA, cycle et nom de l'artefact ;
   - si le statut est `HANDOFF_READY`, la section **« Dossier de correction — à copier dans Claude Code
     Web »** contient le bloc à copier (bouton de copie du bloc de code).
4. Le même texte est disponible dans l'artefact `codex-handoff-pr-<n>-<sha>-<sections>`
   (fichier `dossier-correction.md`), conservé 30 jours.

Lancement manuel (personne propriétaire uniquement) : **Run workflow** → `mode: prepare-pr` et
`pr_number`, ou `mode: demo` pour une démonstration hors ligne (scénarios simulés et exemple de dossier).

## Coller le dossier dans Claude Code Web

1. Vérifier dans la PR que le SHA de tête est toujours celui indiqué dans le dossier.
2. Ouvrir Claude Code Web sur le dépôt `Anand-Helora/TestDoubleIA`.
3. Coller **tel quel** le bloc copié comme premier message et lancer la session.
4. Suivre la session : Claude doit pousser sur la **même branche** `claude/…`, ajouter des tests et ne rien
   fusionner. La CI et la nouvelle revue Codex se déclenchent automatiquement sur le nouveau SHA.
5. Relire et fusionner **manuellement** si tout est vert.

## Limites résiduelles

- **Geste humain obligatoire.** Rien ne garantit qu'un dossier `HANDOFF_READY` sera effectivement traité,
  ni que la correction sera correcte : seule la revue Codex suivante, la CI et la relecture humaine le
  disent.
- **Déduplication bornée à la rétention.** Après expiration de l'artefact (30 jours), un nouvel événement
  Codex sur le même SHA pourrait produire un nouveau dossier. La limite de 2 cycles par PR reste
  calculée par le détecteur A à partir des SHA ayant reçu des remarques classées.
- **Concurrence.** GitHub ne garde qu'une exécution en attente par groupe : un événement intermédiaire
  peut être annulé au profit du plus récent, ce qui est sans conséquence (le plus récent fait foi).
- **Activation après fusion.** Les déclenchements `issue_comment` et `workflow_dispatch` n'utilisent que la
  version du workflow présente sur la branche par défaut : le workflow B2 n'est actif qu'une fois cette PR
  fusionnée. Avant cela, il est vérifié par les tests hors ligne (`node --test`).
- **Statut des fils limité à 100 fils par PR** (comme en phase A) ; au-delà, `UNVERIFIED`.
