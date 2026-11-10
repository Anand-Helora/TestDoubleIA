# Passerelle expérimentale Codex → statut GitHub → Auto-fix (Issue #17)

> **Statut : expérimental, DÉSACTIVÉ par défaut, efficacité NON PROUVÉE.**
> Cette passerelle ne rend pas le système « entièrement automatique ». Elle teste une hypothèse :
> Claude Code Web Auto-fix pourrait réagir à un statut de commit `failure` comme à une CI rouge.
> Tant que cette hypothèse n'a pas été vérifiée sur une PR de laboratoire avec un **véritable**
> finding Codex, la procédure manuelle (section 8) reste la référence.

## 1. Ce qui est prouvé, ce qui ne l'est pas

| Point | État |
| --- | --- |
| Claude Code Web ouvre des PR et pousse des correctifs | prouvé |
| GitHub Actions (Node, Playwright Chromium/Firefox/WebKit) exécute les tests | prouvé |
| Codex relit automatiquement les PR | prouvé |
| Auto-fix réagit à un échec de CI et à un commentaire de **revue humaine** (PR #14) | prouvé |
| Auto-fix réagit à un commentaire du bot `chatgpt-codex-connector[bot]` | **non prouvé** : des signalements publics décrivent un filtrage des événements de bots ([anthropics/claude-code#62977](https://github.com/anthropics/claude-code/issues/62977), [anthropics/claude-code#62096](https://github.com/anthropics/claude-code/issues/62096)) |
| GitHub permet à `GITHUB_TOKEN` (`statuses: write`) de publier un statut de commit | documenté par GitHub ([REST commit statuses](https://docs.github.com/en/rest/commits/statuses)) |
| Auto-fix se réveille sur un statut publié **via l'API par GitHub Actions** | **non prouvé — hypothèse de cette passerelle** |

Ce dépôt ne contient aucun mécanisme qui déclenche Claude. Si le statut n'éveille pas Auto-fix, la
passerelle ne fait qu'ajouter un indicateur rouge ou vert sur la PR : aucun contournement n'est prévu.

## 2. Fichiers

| Fichier | Rôle |
| --- | --- |
| `.github/workflows/codex-status-bridge.yml` | Workflow : `analyze` (lecture seule) puis `publish` (`statuses: write`) |
| `tools/codex-feedback/status-bridge.js` | Décision, garde-fous, idempotence, publication (Node 22, sans dépendance) |
| `tools/codex-feedback/status-bridge-scenarios.js` | Scénarios simulés (démonstration et tests) |
| `tests/codex-status-bridge.test.js` | Tests hors ligne (faux GitHub) et vérifications statiques du workflow |
| `tools/codex-feedback/detect.js` | Détecteur de la phase A, réutilisé ; seule la sélection du résumé Codex est extraite dans `latestCodexSummary` (comportement identique) |
| `tools/codex-feedback/gate.js` | Passerelle B1, réutilisée pour `checkPullRequest`, `checkPermission` et `guardedFetch` (non modifiée) |

Le jeu Snake n'est pas modifié. La passerelle B1 (`codex-feedback-gate.yml`) reste inchangée et
désactivée par `CODEX_GATE_ENABLED` ; la passerelle de statut **ne lit pas** cette variable et **ne
crée aucune réservation** `refs/codex-gate/v1/**` (vérifié par les tests : aucun appel `/git/`).

## 3. Chemin événement → statut

```
issue_comment created/edited (résumé Codex)              workflow_dispatch (demo | evaluate-pr)
   │ pré-filtre `if:` : auteur ET émetteur = chatgpt-codex-connector[bot], PR ouverte
   ▼
┌ analyze ─ contents/pull-requests/issues: read ─ code de la branche par défaut uniquement ──────┐
│ 1. identité complète de l'auteur (login, id 199175422, type Bot, application 1144995)         │
│    et de l'émetteur (`sender`) → sinon SKIP, aucun appel API                                   │
│ 2. relecture API : PR, résumé Codex, reviews, remarques inline, fils GraphQL (detect.js)       │
│ 3. garde-fous B1 : même dépôt, non fork, branche claude/*, label codex-gate:stop,              │
│    auteur de PR `User` avec droit admin/write                                                  │
│ 4. cible : failure | success | pending | aucune (tableau ci-dessous)                          │
│ 5. sorties validées seulement : eligible, pr_number, head_sha, target                         │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
   │ si issue_comment ET eligible == 'true' ET vars.CODEX_STATUS_BRIDGE_ENABLED == 'true'
   ▼
┌ publish ─ statuses: write + lectures ─ concurrence sérialisée par PR ─────────────────────────┐
│ 1. entrées strictes (n° de PR, SHA 40 hex, cible parmi 3 valeurs) ; interrupteur revérifié     │
│ 2. réévaluation COMPLÈTE via l'API (mêmes étapes 2–4) : SHA inchangé, même cible              │
│    → sinon SKIP STALE_SHA / VERDICT_CHANGED                                                    │
│ 3. dernier statut `codex/verified-review` sur ce SHA → doublon : SKIP ALREADY_PUBLISHED        │
│ 4. relecture de la PR juste avant l'écriture : toujours ouverte, SHA inchangé                  │
│ 5. POST /repos/{owner}/{repo}/statuses/{SHA DE TÊTE DE LA PR}                                  │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

Le SHA utilisé est **toujours** `pull.head.sha` relu via l'API, jamais `GITHUB_SHA` (qui, pour un
événement `issue_comment`, désigne le dernier commit de `main`). Un test le vérifie explicitement.

### Correspondance détection → statut

| Situation (détecteur phase A) | Cible | Écriture |
| --- | --- | --- |
| Remarque Codex classée (P0–P3), fil **non résolu** et **non obsolète**, sur le SHA courant (`WOULD_REQUEST_CLAUDE_FIX`) | `failure` | oui, sauf si déjà publié à l'identique |
| Résumé Codex **terminé sur le SHA courant pour toutes les sections exécutées**, `has_unresolved_findings: false`, sans remarque non résolue (`NO_FINDINGS_ON_HEAD` / `FINDINGS_RESOLVED`) | `success` | oui (restaure un `failure` précédent) |
| Revue propre mais **partielle** : une section sur un ancien SHA, ou seul un avis sans résumé terminé | `pending` | seulement si un `success`/`failure` existe déjà sur ce SHA |
| Revue en cours, résumé ambigu ou illisible, signaux contradictoires, fil introuvable (`UNVERIFIED`) | `pending` | seulement si un `success`/`failure` existe déjà sur ce SHA |
| Revue sur un SHA obsolète, aucune revue Codex, PR fermée | aucune | non |
| Limite de 2 cycles atteinte (3e SHA avec remarques) | aucune | non : arrêt de la boucle, reprise humaine |
| Erreur API, quota, données incohérentes | aucune | non (`UNVERIFIED`) |

`pending` ne sert qu'à **suspendre** un verdict devenu potentiellement trompeur (par exemple, une
nouvelle revue Codex lancée sur le même SHA après un `success`). Il n'est jamais créé à partir de rien.

**Statuts obsolètes.** Un statut est attaché à un SHA : dès qu'un nouveau commit est poussé, la PR
affiche les statuts du nouveau SHA et l'ancien `failure` cesse d'apparaître. La passerelle n'écrit
jamais sur un SHA autre que la tête actuelle de la PR.

## 4. Sécurité

| Contrôle | Où | Résultat en cas d'échec |
| --- | --- | --- |
| Auteur du commentaire = Codex (login, id, type, application) | analyze | `SKIP TRIGGER_NOT_FROM_CODEX` |
| Émetteur (`sender`) = Codex : un humain qui édite le résumé n'est pas Codex | `if:` + analyze | `SKIP SENDER_NOT_CODEX` |
| PR ouverte, même dépôt, non fork, branche `claude/*`, auteur admin/write, label d'arrêt | analyze + publish | `SKIP` (raison B1) |
| Interrupteur `CODEX_STATUS_BRIDGE_ENABLED` exactement égal à `true` | `if:` + analyze + publish | `SKIP BRIDGE_DISABLED` |
| SHA de tête inchangé (réévaluation puis relecture juste avant le POST) | publish | `SKIP STALE_SHA` |
| Cible identique après réévaluation | publish | `SKIP VERDICT_CHANGED` |
| Même statut déjà publié par `github-actions[bot]` | publish | `SKIP ALREADY_PUBLISHED` |
| Erreur API ou quota (`429`, `403` avec `x-ratelimit-remaining: 0`) | partout | `UNVERIFIED`, rien n'est publié |

- **Permissions minimales.** `permissions: {}` au niveau du workflow ; `analyze` en lecture seule ;
  `publish` : `statuses: write`, plus `contents: read` (extraction du code), `pull-requests: read`
  et `issues: read` (réévaluation). Aucun `contents: write`, `issues: write`, `pull-requests: write`,
  `pull_request_target`, `workflow_run`, `allowed_bots`, secret, PAT, `ANTHROPIC_API_KEY` ni
  `CLAUDE_CODE_OAUTH_TOKEN` (vérifié par les tests).
- **Aucun code de PR exécuté.** `issue_comment` exécute la version du workflow de la branche par
  défaut, et les deux jobs extraient explicitement cette branche (`persist-credentials: false`,
  extraction partielle de `tools/codex-feedback`).
- **Aucun texte non fiable.** Le texte des commentaires n'est jamais affiché, transmis à un shell ou
  à un agent, ni écrit dans le statut. La description est l'une de trois constantes ; `target_url`
  est construit uniquement à partir de `https://github.com/<dépôt>/actions/runs/<id numérique>` (ou
  de la PR). Les commandes `run:` ne contiennent aucune expression `${{ }}`.
- **Pas d'amplification.** Codex crée puis édite son résumé plusieurs fois : chaque événement
  réévalue l'état, mais un statut identique n'est jamais republié. Les publications d'une même PR sont
  sérialisées (`concurrency`, sans annulation) et chacune relit l'état réel juste avant d'écrire : un
  verdict ancien ne peut pas écraser un verdict plus récent.
- **Boucle bornée.** Un `failure` n'est publié qu'une fois par SHA et par verdict. La limite de deux
  cycles du détecteur (SHA distincts portant des remarques Codex) coupe la boucle
  `failure → correctif → nouvelle remarque` au troisième SHA.

## 5. Activation et arrêt

Rien n'est activé par cette PR. Après fusion manuelle, et seulement pour une expérience :

1. **Settings → Secrets and variables → Actions → Variables → New repository variable** :
   `CODEX_STATUS_BRIDGE_ENABLED` = `true`. Aucun secret n'est nécessaire.
2. Laisser `CODEX_GATE_ENABLED` absente ou différente de `true`.
3. Activer Auto-fix séparément dans Claude Code Web sur la PR de laboratoire.

**Arrêt immédiat :**

- global : supprimer la variable `CODEX_STATUS_BRIDGE_ENABLED` ou lui donner une autre valeur ;
- par PR : ajouter le label `codex-gate:stop` (même label que la passerelle B1) ;
- option radicale : désactiver le workflow (**Actions → Codex status bridge → Disable workflow**).

Ne **pas** rendre le contexte `codex/verified-review` obligatoire dans les règles de protection tant que
l'expérience n'est pas concluante : tout compte disposant de `statuses: write` peut publier un statut
portant ce nom.

## 6. Vérification sur GitHub

- **Actions → Codex status bridge (expérimental) → Run workflow → `demo`** : joue les scénarios
  simulés hors ligne, sans aucun appel API.
- **`evaluate-pr`** avec un numéro de PR : lecture seule, affiche le statut qui *serait* publié
  (`MANUAL_EVALUATION_ONLY`) ; un lancement manuel ne publie jamais.
- Après une revue Codex réelle, le récapitulatif de l'exécution indique décision, raison, SHA et
  statut visé. Le statut publié est visible dans la liste des checks de la PR, et via l'API :

```bash
gh api repos/Anand-Helora/TestDoubleIA/commits/<sha>/statuses --jq '.[] | select(.context=="codex/verified-review") | {state, description, created_at}'
```

Lancement local des tests :

```bash
node --test
```

```bash
BRIDGE_PHASE=demo node tools/codex-feedback/status-bridge.js
```

## 7. Protocole d'expérience (action humaine, hors de cette PR)

1. Faire relire cette PR par la CI et Codex ; la fusionner **manuellement** si la revue est propre.
2. Ouvrir une PR de laboratoire `claude/*` et attendre un **véritable** finding Codex (ne jamais
   simuler un commentaire Codex, ne jamais introduire volontairement de bug sur `main`).
3. Activer `CODEX_STATUS_BRIDGE_ENABLED` et Auto-fix, puis observer :
   - `codex/verified-review` passe à `failure` sur le SHA de tête ;
   - Auto-fix pousse ou non un correctif.
4. Résultats :
   - Auto-fix réagit → documenter la preuve (liens vers le statut et le commit de correction) ;
   - aucun finding Codex réel → **`INCONCLUSIVE`**, ne pas conclure ;
   - le statut est publié mais Auto-fix ne réagit pas → blocage externe : désactiver la variable,
     documenter, conserver la procédure manuelle.

## 8. Procédure manuelle de repli (référence actuelle)

1. Ouvrir la remarque Codex sur la PR (lien dans le récapitulatif de l'exécution).
2. Dans la session Claude Code Web de la PR, demander explicitement la correction, en reformulant
   la remarque avec ses propres mots plutôt qu'en collant le texte du bot.
3. Laisser la CI et Codex relire le nouveau SHA ; résoudre le fil quand la correction est vérifiée.
4. Fusionner manuellement. Aucune fusion automatique ni Auto-merge.

## 9. Limites connues

- **Hypothèse non vérifiée** : rien ne garantit qu'Auto-fix traite un statut d'API comme une CI rouge,
  ni qu'il ne filtre pas les statuts créés par `github-actions[bot]`.
- **Dépendance au format Codex** : marqueur `codex-review-state:v1`, badges `P0`–`P3`, marqueurs de
  section. Un changement de format donne `UNVERIFIED` (aucun statut trompeur), pas une fausse alerte.
- **Résolution d'un fil sans nouvel événement Codex** : si un humain résout un fil sans nouveau commit,
  aucun événement Codex n'arrive et un `failure` reste affiché. Redemander une revue (`@codex review`)
  ou pousser un commit.
- **Section de sécurité non exécutée** : une revue est jugée complète si toutes les sections
  *exécutées* sont terminées sur le SHA courant. Une section que Codex lancerait plus tard n'est pas
  connue d'avance.
- **Fenêtre résiduelle** : entre la dernière relecture du SHA et le POST (quelques millisecondes), un
  push reste possible ; le statut porterait alors sur l'ancien SHA, sans effet sur le nouveau.
- **Usurpation du contexte** : GitHub n'empêche pas un autre compte doté de `statuses: write` de publier
  `codex/verified-review`. La passerelle remplace un tel statut au prochain événement Codex (note
  `FOREIGN_STATUS_REPLACED`) ; d'où la recommandation de ne pas le rendre obligatoire.
- **Historique de statuts** : seule la première page (100 statuts du SHA) est lue pour détecter un
  doublon ; au-delà, au pire un statut identique est republié.
- **Événements de bots** : si GitHub ou Claude Code Web filtrent un jour les événements
  `issue_comment` du bot Codex pour les workflows, la passerelle ne se déclenche simplement pas.
