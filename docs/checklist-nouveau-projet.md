# Checklist : déployer la méthode multi-IA dans un nouveau dépôt HELORA (Issue #21)

> À suivre dans l'ordre. Chaque case se coche **après vérification**, pas par défaut.
> **Ne copier aucun code ni configuration de TestDoubleIA sans revalider son adaptation au nouveau
> projet** : les workflows Codex, les identifiants du bot, les noms de branches, les tests et les
> permissions sont propres à ce laboratoire.

Références : [architecture](architecture-multi-ia.md) · [guide quotidien](runbook-multi-ia.md).

## 0. Avant tout partage de code avec une IA (bloquant)

Aucune ligne de code ne doit être confiée à Claude ou à Codex tant que ces points ne sont pas validés
par écrit avec les personnes responsables (direction, DPO, RSSI ou équivalents).

- [ ] **Droits d'auteur et licences** : le code appartient à HELORA ou sa licence autorise ce partage ;
      aucun code tiers sous licence incompatible ni code client sans accord.
- [ ] **Confidentialité** : le projet n'est couvert par aucun accord (NDA, contrat) interdisant
      l'envoi à un service tiers ; les conditions d'utilisation des données par Anthropic et OpenAI pour
      l'offre utilisée ont été lues (rétention, entraînement, localisation).
- [ ] **Code métier sensible** : identifier ce qui ne doit pas sortir (algorithmes propriétaires,
      logique de facturation, règles cliniques) et l'exclure du dépôt partagé ou du périmètre IA.
- [ ] **RGPD** : aucune donnée personnelle dans le dépôt (code, tests, fixtures, captures, journaux,
      issues, commentaires) ; analyse réalisée avec le DPO si le projet traite des données personnelles.
- [ ] **Données patient** : **aucune** donnée de santé, réelle ou pseudonymisée, dans le dépôt ni dans
      les demandes aux IA. Uniquement des données de test fictives, générées à cet effet.
- [ ] **Secrets** : aucun mot de passe, jeton, clé, certificat ni chaîne de connexion dans le dépôt ou
      son historique ; scanner l'historique avant le premier push (secret scanning GitHub activé).
- [ ] **Infrastructure hospitalière** : aucun nom d'hôte interne, adresse IP, plan réseau, schéma
      d'architecture réel, identifiant d'établissement ni configuration d'équipement.
- [ ] **Règles internes** : la politique HELORA autorise Claude Code Web et Codex pour ce type de
      projet ; décision tracée (date, personne).

## 1. Dépôt et accès

- [ ] Dépôt **privé par défaut** pour tout projet HELORA (TestDoubleIA est public car c'est un
      laboratoire sans donnée réelle).
- [ ] Liste nominative des personnes ayant accès ; droits `write` limités au strict nécessaire ;
      authentification à deux facteurs exigée.
- [ ] Application Claude (GitHub) et connecteur Codex installés **sur ce seul dépôt**, pas sur toute
      l'organisation.
- [ ] Vérifier le quota de minutes GitHub Actions disponible pour un dépôt privé.
- [ ] Aucun secret ni variable créé à ce stade.

## 2. Socle du dépôt

- [ ] `README.md` : objet du projet, lancement, tests, lien vers la documentation multi-IA.
- [ ] Règles de branche sur `main` (Settings → Branches ou Rulesets) :
  - [ ] PR obligatoire, pas de push direct ;
  - [ ] check de CI requis (le job de tests du nouveau projet) ;
  - [ ] au moins une approbation humaine si plusieurs personnes contribuent ;
  - [ ] suppression et force-push interdits ;
  - [ ] **ne pas** rendre obligatoire un statut publié par une passerelle expérimentale
        (ex. `codex/verified-review`).
- [ ] Convention : toute branche produite par Claude commence par `claude/`.
- [ ] CI minimale adaptée à la pile du projet, avec `permissions: contents: read`,
      `persist-credentials: false`, délai maximal par job, déclenchement sur `pull_request` vers `main`.
- [ ] Tests automatisés existants et verts **avant** de confier des tâches à Claude (sans tests, la CI
      et Auto-fix n'ont rien sur quoi s'appuyer).

## 3. Revue Codex et Auto-fix

- [ ] Codex configuré pour relire les PR du dépôt (paramètres Codex cloud) ; vérifier sur une PR de
      test qu'un résumé « Codex Review Summary » apparaît.
- [ ] Vérifier que le compte du bot Codex est bien `chatgpt-codex-connector[bot]` et relever son
      identifiant réel avant de réutiliser un filtre d'identité.
- [ ] Auto-fix activé **par session/PR** dans Claude Code Web, uniquement quand on souhaite qu'il
      réagisse aux échecs de CI et aux commentaires de revue humaine.
- [ ] Aucun Auto-merge, ni dans GitHub, ni dans les outils IA.

## 4. Test pilote (obligatoire avant usage réel)

Sur une branche `claude/*` d'essai, sans fusion :

- [ ] Claude ouvre une PR à partir d'une issue simple.
- [ ] La CI s'exécute et passe.
- [ ] Codex relit et publie son résumé.
- [ ] Un échec de test volontaire **sur la branche de test uniquement** est corrigé par Auto-fix
      (protocole de la PR #14 de TestDoubleIA), puis la PR est fermée sans fusion.
- [ ] Un commentaire de revue humaine est traité par Claude.
- [ ] Le circuit de repli (transmission manuelle d'une remarque Codex) est répété une fois.
- [ ] Résultats consignés (liens vers PR, SHA, exécutions).

## 5. Garde-fous permanents

- [ ] **Jamais d'Auto-merge.** La fusion est toujours un geste humain après lecture du diff.
- [ ] Revue humaine de chaque PR, en particulier de tout fichier sous `.github/`.
- [ ] **Pas de PR depuis un fork** pour les workflows privilégiés : aucun `pull_request_target` avec
      extraction du code de la PR ; les workflows qui écrivent n'exécutent que le code de `main`.
- [ ] Permissions `{}` par défaut dans chaque workflow, élargies job par job.
- [ ] Texte des commentaires (y compris Codex) traité comme non fiable : jamais injecté dans un
      shell ni dans un prompt automatique.
- [ ] Ponts expérimentaux (passerelle de statut, passerelle B1) : **non installés par défaut**. Si un
      pont est repris, il l'est dans une PR dédiée, relue, avec son interrupteur à `false`, activé
      seulement pour une expérience bornée dans le temps puis désactivé.
- [ ] Aucune clé API ajoutée sans décision explicite (coût et conformité).

## 6. Sauvegarde et rollback

- [ ] Sauvegarde du dépôt indépendante de GitHub (miroir privé ou `git clone --mirror` périodique),
      testée par une restauration.
- [ ] Étiquette (`tag`) posée sur `main` avant chaque mise en production.
- [ ] Procédure de retour arrière connue de tous :
  1. ouvrir une PR de **revert** (bouton « Revert » de la PR fautive ou `git revert <sha>`) ;
  2. laisser passer la CI, relire, fusionner manuellement ;
  3. redéployer l'étiquette précédente si le déploiement est découplé de `main`.
- [ ] Interrupteurs d'urgence documentés : désactiver Auto-fix sur la session, désactiver un workflow
      (Actions → workflow → *Disable workflow*), passer une variable d'activation à `false`,
      révoquer l'installation d'une application GitHub.

## 7. Conditions d'entrée en production

Toutes obligatoires :

- [ ] Section 0 validée par écrit.
- [ ] Test pilote (section 4) réussi et consigné.
- [ ] Protection de `main` active et vérifiée (un push direct est refusé).
- [ ] CI verte et revue Codex sans remarque non résolue sur le SHA à déployer.
- [ ] Revue humaine du diff complet depuis la dernière version, par une personne compétente.
- [ ] Revue sécurité spécifique si le changement touche authentification, permissions, données,
      dépendances ou `.github/`.
- [ ] Étiquette de version posée, procédure de rollback relue.
- [ ] Déploiement **hors GitHub Pages** pour tout projet HELORA (Pages n'est utilisé que par le
      laboratoire), dans l'environnement validé par HELORA.
- [ ] Contrôle après déploiement (fonctionnement, journaux) réalisé par un humain.
