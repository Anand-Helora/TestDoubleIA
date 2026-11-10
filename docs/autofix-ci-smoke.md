# Expérience contrôlée Claude Code Web Auto-fix (Issue #12)

## But

Vérifier si **Auto-fix** de Claude Code Web corrige seul un échec de CI sur une PR de test,
**sans clé API Anthropic, sans secret, sans token OAuth, sans `@claude` et sans fusion**.
Auto-fix est un mécanisme de Claude Code Web, distinct des workflows B1/B2 du dépôt :
`CODEX_GATE_ENABLED` n'est pas modifié et le composant `reserve` n'est pas activé.

## Périmètre

- Seul fichier de test concerné : `tests/autofix-smoke.test.js` (une assertion isolée).
- Aucun fichier du jeu Snake n'est modifié.
- Branche : `claude/autofix-ci-smoke` ; la PR reste ouverte, Auto-merge désactivé.

## Protocole

1. **Étape 1 — PR saine.** Le test vérifie `1 + 1 === 2` ; `node --test` passe. La PR est ouverte.
   La personne propriétaire active **Auto-fix** dans la carte de la PR de la session Claude Code Web.
   Rien d'autre n'est poussé avant sa confirmation explicite.
2. **Étape 2 — panne volontaire (après confirmation).** Dans la même branche et la même PR, un seul
   commit change l'assertion en `1 + 1 === 3`, ce qui fait échouer la CI de façon déterministe.
   Personne ne corrige à la main : on observe si Auto-fix se réveille sur l'échec GitHub Actions,
   rétablit l'assertion et pousse un commit correctif.
3. **Vérification.** Nouvelle CI verte (et revue Codex achevée si elle réexamine le SHA). La PR reste
   ouverte pour vérification par la personne propriétaire, qui peut la fermer sans fusion.

## Relevé à compléter

| Événement | SHA | Heure (UTC) | Exécution / référence |
| --- | --- | --- | --- |
| Étape 1 — commit sain | | | |
| Étape 2 — commit volontairement rouge | | | |
| Commit correctif d'Auto-fix | | | |
| CI verte finale | | | |

Si Auto-fix ne réagit pas à l'échec, le consigner tel quel plutôt que d'annoncer un succès.

## Limites

- Seul le déclenchement par **CI** est testé ici ; la réaction aux commentaires de revue du bot
  Codex fera l'objet d'un test distinct.
- Une correction d'Auto-fix ne remplace pas la relecture humaine ; la fusion reste manuelle.
