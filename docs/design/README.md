# Référentiel UX/UI — méthode multi-IA

> **Version de départ proposée — à valider humainement.** Ce référentiel sert de base aux futurs projets et ne modifie pas le jeu Snake de TestDoubleIA.

## Objectif

Faire du design et de l'ergonomie une exigence de projet, dès le cadrage et jusqu'à la revue de la Pull Request (PR), au même titre que les tests fonctionnels et la qualité du code.

## Contenu

- [Principes et profils d'interface](design-system.md) : règles générales et déclinaisons HELORA, terrain, web et outils métier.
- [Modèle de brief UX](ux-brief-template.md) : entrée de l'agent designer **avant** la création d'une Issue GitHub.
- [Grille de revue UX](ux-review-checklist.md) : intervention du designer **après** la création d'une PR.

Ces documents sont des consignes de projet ; **ils ne créent aucun agent ni aucune automatisation à eux seuls**.

## Circuit proposé

1. **Personne demandeuse + ChatGPT** : préciser le problème métier, les utilisateurs, les contraintes et les résultats attendus.
2. **Designer UX (rôle de conception)** : remplir le brief, proposer 1 à 2 parcours ou solutions visuelles, signaler les arbitrages ; aucune modification des objectifs métier sans accord.
3. **Validation humaine du cadrage** : choisir une proposition. L'Issue GitHub contient les exigences fonctionnelles, un lien ou un extrait du brief, les critères d'acceptation et les scénarios à tester.
4. **Claude Code (développement)** : implémenter sur branche et ouvrir une PR, avec tests et, pour une interface, captures d'écran exploitables.
5. **CI + Codex (qualité technique)** : tester et relire la PR selon les contrôles réellement disponibles.
6. **Designer UX (revue)** : comparer les écrans réels et les parcours au brief ; commenter dans la PR avec priorité, preuve, impact utilisateur et correction suggérée. Ne jamais prétendre avoir testé une interface sans l'avoir réellement ouverte.
7. **Correction et nouvelle vérification** : Claude corrige les écarts retenus, puis relance les contrôles. Limiter par défaut à deux cycles de correction avant arbitrage humain.
8. **Personne propriétaire** : lit les changements, vérifie les critères et fusionne manuellement si tout est satisfaisant.

## Règles de gouvernance

- **Source de vérité** : les besoins et critères acceptés dans l'Issue priment ; le designer peut proposer des alternatives, mais **ne change pas la fonctionnalité sans accord**.
- **Portée** : les règles HELORA ne s'appliquent pas automatiquement à une démo ou à une interface native de Revit/AutoCAD.
- **Vérification** : distinguer `observé sur capture`, `testé dans navigateur`, `déduit du code` et `non vérifié`.
- **Sécurité** : sur un dépôt public, uniquement captures et données fictives, jamais patient, personnel, plan sensible, réseau interne, secrets ou fichiers hospitaliers.
- **Automatisation** : l'ajout d'un véritable agent et d'un déclencheur GitHub se fera dans une PR distincte, après un essai manuel du brief et de la grille.
- **Merge** : toujours manuel. Une validation UX ne remplace ni les tests automatiques, ni la revue humaine, ni un avis sécurité.

## Premier pilote

Utiliser une petite amélioration d'interface du jeu Snake **uniquement comme bac d'essai**. Le designer fournit un brief, puis une revue de captures desktop/mobile ; mesurer les remarques utiles, les faux positifs et le temps de correction avant généralisation.
