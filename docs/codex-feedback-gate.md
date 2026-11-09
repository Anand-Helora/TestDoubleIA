# Passerelle de décision Codex → Claude (Issue #9, phase B1)

## Périmètre

La phase B1 ajoute une **passerelle de décision sécurisée** entre les revues Codex et un futur
déclenchement de Claude Code. Elle **n'appelle ni Claude Code Action ni l'API Anthropic**, n'utilise
**aucun secret**, ne corrige rien et ne fusionne rien. La seule écriture possible est une
**réservation persistante** (refs Git `refs/codex-gate/v1/**`), et elle reste désactivée tant que la
personne propriétaire du dépôt n'a pas créé la variable `CODEX_GATE_ENABLED=true`.

| Fichier | Rôle |
| --- | --- |
| `.github/workflows/codex-feedback-gate.yml` | Workflow : analyse (lecture), réservation (écriture bornée), auto-test du stockage |
| `tools/codex-feedback/gate.js` | Garde-fous, réservation atomique, journalisation (Node 22, sans dépendance) |
| `tools/codex-feedback/gate-scenarios.js` | Scénarios simulés (démonstration et tests) |
| `tests/codex-gate.test.js` | Tests : concurrence, doublons inter-exécutions, forks, quotas, erreurs, workflow… |
| `tools/codex-feedback/detect.js` | Détecteur de la phase A, **réutilisé tel quel** (seule `clean` est en plus exportée) |

Le workflow de la phase A (`codex-feedback-dryrun.yml`) et ses tests sont conservés sans changement de
comportement. Le jeu Snake n'est pas modifié.

## Architecture

```
issue_comment (résumé Codex créé/édité)           workflow_dispatch (demo | evaluate-pr | store-self-test)
        │  pré-filtre `if:` : auteur ET émetteur = chatgpt-codex-connector[bot], PR ouverte
        ▼
┌─ job analyze ── permissions : contents/pull-requests/issues: read ──────────────────────────┐
│ gate.js (GATE_PHASE=analyze), code de la branche par défaut uniquement                      │
│  1. identité complète de l'auteur du commentaire ET de l'émetteur (login, id, type, app)    │
│     → sinon SKIP, sans aucun appel API                                                      │
│  2. relecture API + détecteur de la phase A (SHA courant, fils non résolus, sections)       │
│  3. PR du même dépôt, non fork, branche claude/*, label d'arrêt, auteur User avec droit     │
│     admin/write (API collaborators/{login}/permission)                                      │
│  4. sorties validées seulement : eligible, pr_number, head_sha, sections                    │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
        │  si eligible == 'true' ET vars.CODEX_GATE_ENABLED == 'true' ET événement issue_comment
        ▼
┌─ job reserve ── permissions : contents: write, pull-requests: read ─────────────────────────┐
│ gate.js (GATE_PHASE=reserve) : n'accepte que n° de PR, SHA, sections (validés par regex)    │
│  1. revérifie elle-même la PR (ouverte, même dépôt, branche, label), le SHA courant         │
│     (sinon SKIP STALE_SHA) et les droits de l'auteur                                        │
│  2. réservation atomique : verrou du SHA puis premier emplacement de cycle libre            │
│  3. décision finale WOULD_DISPATCH_CLAUDE | SKIP | UNVERIFIED — aucun appel à Claude (B1)   │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Séparation lecture / écriture.** Le job `analyze` lit des données non fiables (commentaires,
événement), mais n'a aucune permission d'écriture. Le job `reserve` dispose de `contents: write`, mais
ne reçoit jamais de texte : seulement trois valeurs au format strict (`^[1-9][0-9]{0,9}$`, SHA hexadécimal
de 40 caractères, sections parmi `code_review` / `security_review`). Il revérifie toutes les conditions
d'identité et de droit côté serveur, via l'API. Aucune expression `${{ }}` n'est interpolée dans une
commande : les valeurs passent par des variables d'environnement, et chaque `run:` vaut exactement
`node tools/codex-feedback/gate.js` (vérifié par les tests).

**Pourquoi seulement `issue_comment`.** Les événements `issue_comment` exécutent **toujours** la version
du workflow de la branche par défaut. Le code d'une PR (y compris un commit de Claude en phase B2) ne peut
donc pas modifier la passerelle qui dispose de `contents: write`. À l'inverse,
`pull_request_review(_comment)` exécute la version du workflow de la PR : ces événements sont
volontairement exclus. Codex crée puis **édite** son résumé à la fin de chaque revue. C'est l'édition
finale (`completed`) qui porte la décision, et les remarques inline sont relues à ce moment-là via l'API.

## Garde-fous

| Contrôle | Où | Résultat en cas d'échec |
| --- | --- | --- |
| Auteur du commentaire = Codex (login, id 199175422, type Bot, application 1144995) | analyze | `SKIP TRIGGER_NOT_FROM_CODEX` (aucun appel API) |
| Émetteur de l'événement (`sender`) = Codex : couvre l'**édition du résumé Codex par un humain** | `if:` + analyze | `SKIP SENDER_NOT_CODEX` (aucun appel API) |
| Détecteur : anomalie confirmée, non résolue, sur le SHA courant | analyze | `SKIP` / `UNVERIFIED` avec la raison du détecteur |
| PR ouverte (relue via l'API) | analyze + reserve | `SKIP PR_NOT_OPEN` |
| Branche source du **même dépôt**, `fork === false` (fork supprimé : `head.repo` nul) | analyze + reserve | `SKIP HEAD_REPO_NOT_ALLOWED` |
| Branche source `claude/…`, jamais la branche par défaut, ni `..`, `.lock` ou un segment commençant par `.` | analyze + reserve | `SKIP BRANCH_NOT_ALLOWED` |
| Auteur de la PR de type `User` avec droit `admin` ou `write` | analyze + reserve | `SKIP AUTHOR_NOT_TRUSTED` |
| Label `codex-gate:stop` sur la PR (arrêt immédiat par PR) | analyze + reserve | `SKIP STOPPED_BY_LABEL` |
| Variable `CODEX_GATE_ENABLED` ≠ `true` (arrêt immédiat global) | `if:` + analyze + reserve | `SKIP GATE_DISABLED` |
| SHA courant identique à celui de l'analyse | reserve | `SKIP STALE_SHA` |
| Lancement manuel | analyze | `SKIP MANUAL_EVALUATION_ONLY` (éligibilité affichée, aucune réservation) |

Le texte des commentaires (y compris les injections testées : `@claude`, `curl … | sh`, `rm -rf`,
« ignore previous instructions ») n'est **jamais** affiché, transmis ni interprété. Le journal, le
récapitulatif et les sorties de step ne contiennent que des énumérations, des nombres, des SHA et des
liens `https://github.com/<dépôt>/…` validés. Le jeton n'apparaît jamais (vérifié par les tests).

## Déduplication persistante : refs Git créées de façon atomique

### Mécanisme retenu

L'API `POST /repos/{owner}/{repo}/git/refs` crée une ref **seulement si elle n'existe pas** : une
seconde création échoue avec `422 Reference already exists`. Cette opération de type
*create-if-absent*, exécutée côté GitHub, est **atomique** : sur N créations concurrentes, une seule
réussit. Elle est aussi **durable** (indépendante des exécutions, sans expiration) et ne demande
**aucun secret** (`GITHUB_TOKEN` avec `contents: write`).

| Ref | Cible | Rôle |
| --- | --- | --- |
| `refs/codex-gate/v1/pr-<n>/sha/<sha>` | objet tag annoté (enregistrement) | **1 tentative par SHA** : verrou unique |
| `refs/codex-gate/v1/pr-<n>/cycle/<k>` (k = 1, 2) | même enregistrement | **2 cycles par PR** : emplacements uniques |

L'enregistrement est un objet tag annoté (`POST /git/tags`) pointant sur le commit de tête. Son message
contient `codex-gate-record:v1` suivi d'un JSON strict : `kind`, `key`
(`codex-fix:pr-<n>:<sha>:<sections>`), `pr`, `sha`, `sections`, `runId`, `runAttempt`, `createdAt`.
Il ne contient aucun texte non fiable. Son identifiant est unique par exécution, ce qui permet de
reconnaître sa propre réservation.

### Algorithme

1. Créer l'enregistrement. En cas d'échec : `UNVERIFIED`, rien n'est réservé.
2. Créer le verrou du SHA :
   - `created` : on poursuit ;
   - `exists` : `SKIP`, jamais de seconde tentative. La raison est qualifiée par la relecture de
     l'enregistrement et des emplacements :
     - `DUPLICATE_EVENT` : même clé (événement rejoué, résumé créé puis édité, relance du workflow) ;
     - `NEW_FINDING_ON_ATTEMPTED_SHA` : autre section sur un SHA déjà tenté ;
     - `CYCLE_LIMIT_REACHED` : verrou posé alors que les deux emplacements étaient pris ;
     - `SHA_LOCKED_WITHOUT_CYCLE` : échec antérieur entre les deux étapes, déblocage humain ;
     - `SHA_ALREADY_RESERVED` : enregistrement illisible ou falsifié, échec sûr.
3. Créer `cycle/1`, puis `cycle/2` si `cycle/1` existe déjà. Le premier `created` donne
   `WOULD_DISPATCH_CLAUDE` avec le cycle réservé. Si tous les emplacements existent :
   `SKIP CYCLE_LIMIT_REACHED`.

**Réponse perdue.** Si une création échoue (réseau, 5xx), la ref est relue. Si elle désigne notre
enregistrement, la création avait réussi. Si elle en désigne un autre, c'est un doublon. Si elle est
absente, l'erreur est remontée.

**Échec après réservation.** Si le verrou du SHA est posé mais que l'emplacement de cycle échoue, le
résultat est `UNVERIFIED RESERVATION_INCOMPLETE`. Le SHA reste verrouillé, sans nouvelle tentative
automatique (choix *fail-closed*), et les exécutions suivantes répondent
`SKIP SHA_LOCKED_WITHOUT_CYCLE`.

Pour débloquer manuellement un SHA, supprimer la ref de verrou, par exemple avec la CLI GitHub :

```bash
gh api -X DELETE repos/Anand-Helora/TestDoubleIA/git/refs/codex-gate/v1/pr-<n>/sha/<sha>
```

**Ordre verrou puis cycle.** Un SHA bloqué par la limite consomme son verrou, mais ne consomme jamais
de cycle. À l'inverse, un doublon ne peut jamais consommer de cycle.

### Alternatives écartées

| Mécanisme | Raison du rejet |
| --- | --- |
| `Set` en mémoire / `seenKeys` (phase A) | Perdu à chaque exécution |
| Groupe `concurrency` | Ni durable ni exhaustif : GitHub n'y garde qu'une exécution en attente et annule les autres |
| Label ou commentaire marqueur | Aucune opération conditionnelle (*compare-and-set*) : deux exécutions concurrentes réussissent toutes les deux. Le commentaire est en outre éditable |
| Cache Actions | Portée par branche, évincé après 7 jours sans accès : non durable |
| Variables Actions | Nécessitent un jeton administrateur (secret), sans écriture conditionnelle |
| Check runs / statuts | Aucune création exclusive |

### Preuves

- **Tests (CI)** : stockage en mémoire aux mêmes sémantiques et faux GitHub HTTP reproduisant le
  `422 Reference already exists`. Ils couvrent :
  - 20 exécutions concurrentes sur le même SHA, dont une seule réservation ;
  - 3 SHA concurrents, dont deux cycles réservés et le troisième bloqué ;
  - la persistance entre deux exécutions indépendantes ;
  - la réponse perdue, l'échec après réservation et l'enregistrement falsifié ;
  - un stockage non atomique, détecté par l'auto-test.
- **Sur le vrai GitHub** : le mode `store-self-test` (propriétaire seulement, après fusion) crée
  `refs/codex-gate/v1/selftest/<run_id>/…`, vérifie le refus du doublon, lance 5 créations
  concurrentes (un seul gagnant attendu), relit, puis supprime les refs. Résultat : `PASS` ou `FAIL`.

> **Limite bloquante pour B2** : l'atomicité et l'acceptation de l'espace `refs/codex-gate/` par
> l'API REST de GitHub sont garanties par la sémantique documentée de `git/refs`. Elles ne sont toutefois
> **prouvées sur le vrai GitHub qu'après un `store-self-test` réussi**, impossible avant la fusion
> (`workflow_dispatch` n'est disponible qu'une fois le workflow présent sur `main`). B2 ne doit pas être
> activée sans ce `PASS`. Si l'espace personnalisé était refusé, la solution de repli serait
> `refs/tags/codex-gate/…`, qui reste invisible des `git clone` sans `--tags` mais déclenche les
> workflows `on: push: tags`. Aucun workflow de ce dépôt n'en a.

## Limites strictes et arrêt

- **1 tentative par SHA** (verrou) et **2 cycles par PR** (emplacements). C'est aussi la protection
  anti-boucle : la correction d'une correction ne peut pas dépasser 2 cycles. Le détecteur de la phase A
  compte en plus les SHA ayant des remarques classées et répond déjà `CYCLE_LIMIT_REACHED` au-delà
  de 2.
- **Arrêt global immédiat** : supprimer la variable `CODEX_GATE_ENABLED` ou la passer à une autre
  valeur que `true`. Une seconde option est de désactiver le workflow (Actions → Codex feedback
  gate → Disable workflow).
- **Arrêt par PR** : ajouter le label `codex-gate:stop`.
- **Aucune fusion automatique** : le workflow n'a pas `pull-requests: write`, et rien ne fusionne.
  En phase B2, une proposition de fusion ne pourra venir qu'après CI verte et revue Codex sur le nouveau
  SHA, avec l'accord de la personne propriétaire du dépôt.

## Décisions journalisées

Chaque étape publie une notice `::notice`, une ligne JSON et un récapitulatif. La ligne JSON contient
notamment `stage`, `decision`, `reason`, `prNumber`, `headSha`, `idempotencyKey`, `cycle` et `notes`.

| Étape | Décision | Raisons |
| --- | --- | --- |
| reserve | `WOULD_DISPATCH_CLAUDE` | `RESERVED_NO_DISPATCH_IN_B1` (SHA et cycle réservés ; B1 n'appelle rien) |
| analyze | `ELIGIBLE` (intermédiaire) | `ELIGIBLE_PENDING_RESERVATION` |
| analyze / reserve | `SKIP` | `TRIGGER_NOT_FROM_CODEX`, `SENDER_NOT_CODEX`, `NO_FINDINGS_ON_HEAD`, `FINDINGS_RESOLVED`, `REVIEW_ON_STALE_SHA`, `NO_CODEX_REVIEW`, `PR_NOT_OPEN`, `HEAD_REPO_NOT_ALLOWED`, `BASE_REPO_MISMATCH`, `BRANCH_NOT_ALLOWED`, `AUTHOR_NOT_TRUSTED`, `STOPPED_BY_LABEL`, `GATE_DISABLED`, `MANUAL_EVALUATION_ONLY`, `STALE_SHA`, `DUPLICATE_EVENT`, `NEW_FINDING_ON_ATTEMPTED_SHA`, `CYCLE_LIMIT_REACHED`, `SHA_LOCKED_WITHOUT_CYCLE`, `SHA_ALREADY_RESERVED`, `UNSUPPORTED_EVENT`, … |
| analyze / reserve | `UNVERIFIED` | `REVIEW_IN_PROGRESS`, `FINDING_STATUS_UNKNOWN`, `CONTRADICTORY_SIGNALS`, `SUMMARY_*`, `API_ERROR`, `API_RATE_LIMITED`, `MISSING_CONTEXT`, `PR_DATA_INCOMPLETE`, `INVALID_INPUT`, `RESERVATION_INCOMPLETE` |
| self-test | `PASS` / `FAIL` | `STORE_ATOMIC_AND_DURABLE` / `STORE_CHECK_FAILED` (détail par contrôle dans `notes`) |

Le quota d'API (`429`, ou `403` avec `x-ratelimit-remaining: 0` ou `retry-after`) donne
`UNVERIFIED API_RATE_LIMITED`. Un `403` sans ces indicateurs reste une erreur ordinaire.

## Démonstration et essais

En local, sans réseau :

```bash
node --test
```

```bash
GATE_PHASE=demo node tools/codex-feedback/gate.js
```

Après fusion, depuis **Actions → Codex feedback gate (B1) → Run workflow** :

- `demo` : 15 scénarios hors ligne (1 positif, 14 négatifs), tableau dans le récapitulatif ;
- `evaluate-pr` + `pr_number` : évaluation réelle en lecture seule, sans aucune réservation ;
- `store-self-test` : preuve du stockage sur GitHub (propriétaire uniquement, refs temporaires
  supprimées).

## Limites techniques

1. **Preuve réelle après fusion seulement** (voir l'encadré ci-dessus). Jusque-là, la persistance est
   prouvée par simulation fidèle uniquement.
2. **`contents: write` est large** : le `GITHUB_TOKEN` du job `reserve` pourrait techniquement pousser
   sur n'importe quelle branche. Ce risque est atténué :
   - le job n'exécute que le code de la branche par défaut (`issue_comment`) ;
   - `persist-credentials: false` ;
   - `assertGateRef` refuse toute ref hors de `refs/codex-gate/v1/(pr-<n>/(sha|cycle)/…|selftest/…)`
     (testé).

   **Recommandé** : une règle de protection (*ruleset*) sur `main`. GitHub n'offre pas de permission de
   jeton limitée à un espace de refs.
3. **Réservations visibles publiquement** : `git ls-remote` liste les refs `codex-gate`, avec le
   n° de PR, le SHA, les sections et le n° d'exécution. Ces données ne sont pas sensibles. Elles ne sont
   pas récupérées par un `git clone` normal.
4. **Aucun nettoyage automatique** : les refs restent après la fermeture de la PR (quelques octets
   chacune), et elles maintiennent le commit référencé accessible. Elles se nettoient manuellement avec
   `git push origin --delete refs/codex-gate/v1/pr-<n>/…` ou via l'API.
5. **Édition d'un commentaire Codex par un administrateur** : l'événement est écarté
   (`SENDER_NOT_CODEX`). En revanche, l'API REST n'indique pas qui a édité un commentaire en dernier : un
   résumé Codex modifié par un administrateur, puis relu lors d'un événement Codex ultérieur, serait pris
   en compte. Seuls les administrateurs peuvent le faire. Le champ GraphQL `editor` permettrait de durcir
   ce point en B2.
6. **La réservation ne relance pas le détecteur** : elle revérifie le SHA, la PR et les droits, mais
   s'appuie sur l'analyse faite quelques secondes plus tôt pour le statut des fils. Une remarque résolue
   entre-temps serait quand même réservée, ce qui est sans effet en B1. En B2, l'agent devra relire les
   fils avant d'agir.
7. **Dépendance au résumé Codex** : sans création ou édition du résumé par Codex, aucune évaluation
   n'est lancée. C'est un échec sûr. Le format Codex reste non documenté (limites de la phase A).
8. **Quotas** : 1 tentative par SHA, 2 cycles par PR, pas de plafond global quotidien. À ajouter en B2
   pour borner le coût sur l'ensemble du dépôt.
9. **Groupe `concurrency` du job `reserve`** : GitHub annule les exécutions en attente au-delà d'une.
   C'est sans conséquence (l'atomicité vient des refs et l'exécution suivante relit tout), mais cela
   apparaît comme « cancelled » dans l'onglet Actions.
10. **Droits de l'auteur** : l'endpoint `collaborators/{login}/permission` est supposé accessible au
    `GITHUB_TOKEN` (permission `metadata: read`, implicite). En cas de refus, le résultat est
    `UNVERIFIED API_ERROR` (échec sûr), à confirmer par `evaluate-pr` après fusion.

## Préparation de la phase B2 (non activée) : configuration manuelle requise

**Déclenchement.** Un commentaire `@claude` posté avec le `GITHUB_TOKEN` ne déclenche **aucun**
workflow : GitHub l'interdit pour éviter les boucles, et la FAQ de `claude-code-action` le confirme. Il
ne faut donc pas s'appuyer dessus. D'après la documentation GitHub « Triggering a workflow » (à
reconfirmer, inaccessible depuis cette session), `workflow_dispatch` et `repository_dispatch` font
exception. Architecture recommandée :

1. **B2 « approuvée »** (recommandée pour un dépôt public) :
   - après `WOULD_DISPATCH_CLAUDE`, la passerelle ne fait qu'afficher la décision ;
   - la personne propriétaire lance un workflow `claude-fix` par `workflow_dispatch`, avec le n° de PR
     et le SHA réservé ;
   - ce workflow utilise un **environnement GitHub protégé** (`environment: claude-fix`, *required
     reviewers* = propriétaire, branches de déploiement limitées à `main`) ;
   - il revérifie la réservation (ref `cycle/<k>` pointant sur l'enregistrement du SHA courant), puis
     appelle l'action en mode `prompt`.

   L'action ne revérifie pas les droits pour `workflow_dispatch`, puisque GitHub exige déjà l'accès en
   écriture pour lancer le workflow : aucun `allowed_bots` n'est nécessaire.
2. **B2 « automatique »** :
   - la passerelle émet elle-même un `workflow_dispatch` (permission `actions: write`) ;
   - le job `claude-fix` reste soumis à l'approbation de l'environnement protégé.

   Une automatisation **totale, sans approbation humaine, n'est pas recommandée** sur un dépôt public.
   Le texte des remarques Codex peut citer du contenu de PR, et reste une entrée non fiable (injection de
   prompt), même avec les filtres de l'action.

**Authentification compatible avec l'action** (documentation `security.md`) :

- `anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}` : facturation à l'usage de l'API Anthropic,
  **distincte** de tout abonnement claude.ai ;
- **ou** `claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}` : jeton généré par
  `claude setup-token`, qui consomme les quotas de l'abonnement associé. Il **ne faut pas présumer** que
  l'abonnement Claude Code web couvre cet usage : vérifier les conditions et quotas en vigueur avant
  l'activation.

Bedrock et Vertex existent aussi, mais ne sont pas couverts par la page de sécurité. Dans tous les cas,
le secret est stocké **uniquement** dans les secrets du dépôt ou de l'environnement protégé. Il ne doit
**jamais** figurer dans un commentaire, le code ou les journaux, ni être demandé dans un commentaire.

**Contraintes à reprendre en B2** :

- jamais `allowed_bots: '*'`, ni `allowed_non_write_users` ;
- `include_comments_by_actor` limité au propriétaire et à Codex ;
- outils restreints (`--allowedTools`) ;
- interdiction de modifier `.github/` ;
- aucune écriture sur `main` ;
- pas de `pull_request_target` avec checkout du code de la PR ;
- commits poussés avec le jeton de l'application Claude (un commit poussé avec le `GITHUB_TOKEN` ne
  relancerait ni la CI ni la revue Codex) ;
- revue Codex et CI à repasser sur le nouveau SHA, fusion à décision humaine seulement ;
- plafond global de coût (nombre de réservations par jour) ;
- relecture des fils juste avant l'appel ;
- `store-self-test` en `PASS`.
