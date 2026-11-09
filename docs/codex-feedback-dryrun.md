# Détection des remarques Codex — mode « dry run » (Issue #5, phase A)

## Objectif et périmètre

Préparer le chaînage **revue Codex → demande de correction Claude → CI → revue Codex** en commençant par
un **détecteur en lecture seule**. Ce détecteur :

- observe les revues Codex sur les pull requests **ouvertes** ;
- vérifie, via l'API GitHub en lecture seule, qu'une anomalie Codex **réelle et non résolue** existe sur le
  **SHA courant** de la PR ;
- publie une décision dans le journal et le récapitulatif de l'exécution (*step summary*).

Il **n'exécute pas Claude, ne modifie aucun code, n'écrit rien sur GitHub** (ni commentaire, ni label, ni
statut), n'utilise **aucun secret** et n'a **aucune permission d'écriture**. La phase B (intégration de
Claude) n'est pas activée.

| Fichier | Rôle |
| --- | --- |
| `.github/workflows/codex-feedback-dryrun.yml` | Workflow déclenché par les événements de revue |
| `tools/codex-feedback/detect.js` | Détecteur (Node 22, aucune dépendance) |
| `tests/codex-feedback.test.js` | Tests de simulation, exécutés par `node --test` (workflow `Tests`) |
| `tests/fixtures/codex/*.json` | Scénarios simulés, aussi utilisables par `workflow_dispatch` |

## Fonctionnement

```
Événement GitHub ──► pré-filtre `if:` (auteur = compte bot Codex, PR ouverte)
                     │
                     ▼
      detect.js : lit l'événement uniquement pour connaître le n° de PR
                  et revérifie l'identité complète de l'auteur
                     │  (auteur non Codex → NO_ACTION, aucun appel API)
                     ▼
      Relecture API (GET REST + 1 requête GraphQL `query`) :
      PR (état, SHA courant), commentaires, reviews, remarques inline, statut des fils
                     │
                     ▼
      Décision + clé d'idempotence ──► journal (::notice), step summary, sorties du step
```

La décision repose **exclusivement sur les données relues via l'API**, jamais sur le contenu de
l'événement : un événement « positif » n'efface pas une remarque non résolue, et inversement.

## Événements utilisés

| Événement | Actions | Ce qu'il porte chez Codex |
| --- | --- | --- |
| `issue_comment` | `created`, `edited` | Commentaire récapitulatif « Codex Review Summary », créé puis **édité** à chaque revue |
| `pull_request_review` | `submitted`, `edited` | Soumission d'une revue Codex (quand il a des suggestions) |
| `pull_request_review_comment` | `created`, `edited` | Remarques inline de Codex, avec badge de priorité P0–P3 |
| `workflow_dispatch` | — | Test manuel contrôlé (voir plus bas) |

Limites de ces événements :

- **`issue_comment` et `workflow_dispatch` n'utilisent que la version du workflow présente sur la branche
  par défaut.** Le détecteur ne réagira donc réellement aux résumés Codex qu'**après fusion** dans `main`.
- `pull_request_review` et `pull_request_review_comment` exécutent la version du workflow de la **PR**.
  Le workflow récupère toutefois toujours le code du détecteur depuis la **branche par défaut**, jamais
  le code de la PR. Avant la fusion, ce code est absent : le job l'indique par une notice et s'arrête
  sans erreur.
- Les **réactions** de Codex (👀 pendant la revue, 👍 sans remarque) ne déclenchent aucun workflow.
- Chaque commentaire de PR (même humain) crée une exécution, **ignorée** (*skipped*) par le pré-filtre :
  elle apparaît dans l'onglet Actions sans consommer de minutes.
- Le groupe `concurrency` sérialise les analyses d'une même PR ; GitHub ne garde qu'une exécution en
  attente par groupe, ce qui est sans conséquence puisque chaque analyse relit l'état complet.

## Identification de Codex

Valeurs relevées sur le commentaire Codex de la PR #4 et figées dans `detect.js` :

| Champ | Valeur attendue |
| --- | --- |
| `user.login` | `chatgpt-codex-connector[bot]` |
| `user.id` | `199175422` |
| `user.type` | `Bot` |
| `performed_via_github_app` (si présent) | `id` 1144995, `slug` `chatgpt-codex-connector` (propriétaire `openai`) |

Les quatre critères sont exigés. Le suffixe `[bot]` est réservé par GitHub aux applications, et
l'identifiant numérique empêche un compte homonyme. Ces critères s'appliquent :

1. à l'**auteur de l'événement**. Un commentaire d'un tiers contenant « @codex » ou imitant le format du
   résumé produit `NO_ACTION / TRIGGER_NOT_FROM_CODEX`, **sans aucun appel API** ;
2. à **chaque élément relu** via l'API. Les faux résumés ou fausses remarques de tiers sont ignorés.

`author_association` vaut `NONE` pour Codex et n'est donc pas utilisé.

## Signaux Codex exploités

1. **Résumé** (commentaire de conversation) : marqueur HTML
   `<!-- codex-review-state:v1 {...} -->`, avec, pour `code_review` et `security_review`, le
   `commit_sha` revu, le `status` et `has_unresolved_findings`. Le résumé Codex le plus récent fait foi.
2. **Remarques inline** : commentaires de revue Codex racines (hors réponses), rattachés au commit de
   leur revue, avec un badge `![P0..P3 Badge](https://img.shields.io/badge/...)` et un marqueur de
   section `<!-- codex-code-review-finding:v1 -->`. Ce format a été observé sur la revue Codex de la
   PR #6. Le marqueur `codex-security-review-finding:v1` est **supposé** par symétrie et n'a pas encore
   été observé. Une remarque sans marqueur est rattachée à `code_review`, avec la note
   `SECTION_DEFAULTED`.
3. **Statut des fils** (résolu / obsolète) : uniquement disponible via GraphQL (`reviewThreads`).

Le texte des remarques n'est **jamais** affiché, enregistré ni interprété. Seuls l'identifiant, la
priorité et un lien `https://github.com/<dépôt>/…` validé sont repris.

## Décisions

| Décision | Raison (`reason`) | Signification |
| --- | --- | --- |
| `WOULD_REQUEST_CLAUDE_FIX` | `CONFIRMED_UNRESOLVED_FINDINGS_ON_HEAD` | Remarque Codex non résolue confirmée sur le SHA courant |
| `NO_ACTION` | `NO_FINDINGS_ON_HEAD` | Revue Codex du SHA courant sans anomalie |
| `NO_ACTION` | `FINDINGS_RESOLVED` | Remarques du SHA courant toutes résolues ou obsolètes |
| `NO_ACTION` | `REVIEW_ON_STALE_SHA` | Remarques Codex uniquement sur un ancien commit |
| `NO_ACTION` | `NO_CODEX_REVIEW` | Aucune revue Codex sur la PR |
| `NO_ACTION` | `PR_NOT_OPEN` | PR fermée ou fusionnée (vérifié via l'API) |
| `NO_ACTION` | `TRIGGER_NOT_FROM_CODEX` | Événement d'un autre auteur |
| `NO_ACTION` | `NOT_A_PULL_REQUEST`, `UNSUPPORTED_EVENT`, `UNSUPPORTED_ACTION` | Hors périmètre |
| `NO_ACTION` | `DUPLICATE_ALREADY_REPORTED` | Clé d'idempotence déjà traitée |
| `NO_ACTION` | `CYCLE_LIMIT_REACHED` | Plus de 2 cycles : décision humaine requise |
| `UNVERIFIED` | `MALFORMED_PAYLOAD`, `API_DATA_INVALID`, `API_ERROR`, `MISSING_CONTEXT` | Données absentes ou invalides |
| `UNVERIFIED` | `REVIEW_IN_PROGRESS` | Revue Codex en cours sur le SHA courant |
| `UNVERIFIED` | `SUMMARY_STATE_UNREADABLE`, `SUMMARY_AMBIGUOUS` | Marqueur d'état illisible, invalide ou sans indicateur |
| `UNVERIFIED` | `FINDING_STATUS_UNKNOWN` | Remarque sans badge reconnu, ou statut du fil inconnu (GraphQL indisponible) |
| `UNVERIFIED` | `CONTRADICTORY_SIGNALS` | Le résumé et les fils **d'une même section** se contredisent (détail dans `notes`) |

Ni `NO_ACTION` ni `UNVERIFIED` ne mènent à une action. Le job réussit dans tous ces cas ; seule une
erreur interne du détecteur le fait échouer.

## Sections de revue et contradictions

Codex publie deux sections indépendantes dans son résumé : `code_review` et `security_review`. Chaque
remarque inline est rattachée à sa section par son marqueur. Les contradictions ne sont évaluées
**qu'à l'intérieur d'une même section** :

- résumé de la section « sans remarque non résolue » alors qu'un de ses fils est non résolu →
  `UNVERIFIED` (`<section>:SUMMARY_CLEAN_THREAD_UNRESOLVED`) ;
- résumé de la section « remarques non résolues » alors que tous ses fils sont résolus ou obsolètes →
  `UNVERIFIED` (`<section>:SUMMARY_UNRESOLVED_THREADS_RESOLVED`).

Des fils `code_review` résolus ne masquent donc plus une anomalie signalée indépendamment par
`security_review` (revue Codex de la PR #6, P2 n°2).

Une remarque inline non résolue est retenue même si le résumé de la même section est encore
`running` : c'est la séquence réellement observée sur la PR #6. Les remarques ligne par ligne ont été
publiées à 22:20 et le résumé est passé à `completed` à 22:32.

## Idempotence et limite de cycles

- **Clé** : `codex-fix:pr-<n>:<sha courant>:<sections>`, par exemple
  `codex-fix:pr-6:e1bcd54…:code_review` ou `…:code_review+security_review`.
  Une observation est identifiée par sa **section**, quel que soit le signal qui la porte (remarque inline
  ou résumé), et indépendamment des identifiants, du texte et des dates des commentaires. La clé est donc
  identique :
  - quand une remarque inline est suivie du résumé final (ou l'inverse) — revue Codex de la PR #6,
    P2 n°1 ;
  - pour la création puis l'édition du résumé, la revue et la remarque inline ;
  - après une édition de texte.

  Un nouveau SHA ou une nouvelle section produit une nouvelle clé.
- **Compromis assumé** : deux remarques distinctes de la **même section sur le même SHA** (par exemple
  une seconde revue manuelle du même commit) partagent la clé. C'est cohérent avec la règle « au plus un
  cycle de correction automatique par SHA ». La remarque supplémentaire reste visible dans la liste des
  remarques retenues et sera traitée au cycle suivant, sur le nouveau SHA. Une identité plus fine par
  remarque n'est pas possible, car le résumé n'indique qu'un booléen par section et ne permet pas de
  relier ses remarques aux commentaires inline.
- **Phase A** : le workflow étant en lecture seule, les clés déjà traitées ne sont **pas mémorisées**.
  Plusieurs exécutions peuvent afficher la même décision avec la même clé. Le détecteur prend déjà en
  charge un ensemble de clés connues (`seenKeys`, testé), que la phase B alimentera depuis un stockage
  persistant.
- **Cycles** : nombre de commits distincts sur lesquels Codex a laissé des remarques classées (P0–P3),
  SHA courant compris. Au-delà de **2** (règle du pilote), la décision devient
  `NO_ACTION / CYCLE_LIMIT_REACHED`.

## Sécurité

- `permissions: contents: read, pull-requests: read, issues: read` au niveau du workflow, aucune
  permission au niveau du job.
- Aucun secret : seul le jeton automatique `github.token`, limité à ces permissions, sert aux lectures.
- Pas de `pull_request_target`. `actions/checkout` récupère la **branche par défaut** pour les
  événements de PR (ou la ref choisie lors d'un lancement manuel), avec `persist-credentials: false` et
  un *sparse checkout* limité au détecteur et aux fixtures. Le code de la PR n'est jamais exécuté.
- Aucune expression `${{ }}` n'est interpolée dans une commande. Le nom de scénario manuel passe par une
  variable d'environnement, validé (`[a-z0-9-]`) et limité au dossier des fixtures.
- Aucun texte de commentaire n'est affiché. Les valeurs écrites dans le journal sont nettoyées des
  séquences de commandes de workflow (`::`, sauts de ligne).
- Les tests vérifient statiquement ces propriétés du workflow (permissions, absence de secrets, de
  `pull_request_target`, de `claude-code-action`, ref du checkout, commandes).

## Test manuel contrôlé

Onglet **Actions → Codex feedback (dry run) → Run workflow** (disponible après fusion dans `main`) :

- **Scénario simulé** : choisir une valeur de `fixture` (par exemple `finding-on-head`). Aucun appel API
  n'est fait et aucun bug n'est introduit dans `main`.
- **PR réelle** : laisser `fixture` à `none` et saisir `pr_number` ; analyse en lecture seule.

En local :

```bash
node --test                                                            # toute la suite
node tools/codex-feedback/detect.js --fixture tests/fixtures/codex/finding-on-head.json
```

## Limites techniques identifiées

1. **Format Codex non documenté publiquement** : le marqueur `codex-review-state:v1`, les badges P0–P3
   et le marqueur `codex-code-review-finding:v1` ont été observés (PR #4 et #6), pas spécifiés. Le format
   des remarques `security_review` n'a pas été observé. En cas de changement, le détecteur répond
   `UNVERIFIED` ou ignore le contenu, et ne déclenche jamais d'action à tort. Une remarque de sécurité
   sans marqueur reconnu serait rattachée à `code_review` : ses contradictions seraient alors évaluées
   avec la mauvaise section.
2. **Identité figée** : si Codex change de compte ou d'application, plus rien n'est détecté (échec sûr)
   tant que `CODEX` n'est pas mis à jour.
3. **Activation après fusion seulement** pour les résumés (`issue_comment`) et le lancement manuel. Avant
   cela, seuls les tests de simulation en CI valident le détecteur.
4. **Statut des fils seulement en GraphQL** ; au-delà de 100 fils, ou si GraphQL échoue, les remarques
   inline sont `UNVERIFIED` (sauf si le résumé confirme l'anomalie). La pagination REST est limitée à
   10 pages de 100 éléments ; au-delà, `API_ERROR`.
5. **Pas de mémoire en phase A** : l'idempotence est calculée mais non persistée (cela exigerait une
   écriture).
6. **Comptage des cycles** fondé sur les remarques inline. Le résumé étant réédité sur place, un
   historique de remarques signalées uniquement par le résumé ne serait pas compté.
7. **PR issues de forks** : `pull_request_review(_comment)` exécute alors la version du workflow du fork,
   avec un jeton en lecture seule et sans secret. C'est acceptable en phase A, mais la phase B devra
   exclure les forks.
8. **Événements des bots** : les contenus publiés par l'application Codex déclenchent bien les workflows,
   contrairement à ceux publiés avec le `GITHUB_TOKEN` d'un workflow. À confirmer en conditions réelles
   après fusion.

## Préparation de la phase B (non activée)

Contraintes à respecter, à concevoir dans une PR distincte :

- `anthropics/claude-code-action` ne serait appelé que pour `WOULD_REQUEST_CLAUDE_FIX`, sur des branches
  `claude/*` du dépôt lui-même (pas de fork), avec vérification de l'acteur. Il n'y aurait ni
  modification de `main` ni fusion automatique.
- La clé `ANTHROPIC_API_KEY` serait ajoutée uniquement comme **secret** du dépôt, jamais dans le code ni
  les journaux.
- La persistance des clés d'idempotence (commentaire marqueur ou label) demandera une permission
  d'écriture limitée et justifiée. Il y aurait au plus un cycle automatique par SHA et 2 cycles par PR,
  avec arrêt et notification en cas de régression ou de répétition.
- Un commit poussé avec le `GITHUB_TOKEN` ne relance pas les workflows : il faudra un autre jeton ou un
  déclenchement explicite pour relancer CI et revue.
- Le texte des remarques Codex et des commentaires de PR est une entrée **non fiable** (injection de
  prompt), ce qui est particulièrement important sur un dépôt public. Il ne devra être transmis à Claude
  qu'avec des outils restreints et sans accès aux secrets.
