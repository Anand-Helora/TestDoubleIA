/*
 * Scénarios simulés du dossier de correction Codex → Claude Code Web (Issue #11, phase B2).
 * Utilisés par la démonstration hors ligne (HANDOFF_PHASE=demo) et par tests/codex-handoff.test.js.
 * Aucun appel réseau. Les données reprennent celles de la phase B1 (gate-scenarios.js).
 */
'use strict';

const S = require('./gate-scenarios.js');
const H = require('./handoff.js');

const { REPO, HEAD, NEW_HEAD, CODEX_USER, OWNER, OUTSIDER } = S;

function clone(v) { return JSON.parse(JSON.stringify(v)); }

/** API dont l'URL de la remarque inline pointe ailleurs que sur la PR (lien malveillant). */
function maliciousUrlApi(url) {
  const api = S.findingApi();
  api.reviewComments[0].html_url = url;
  return api;
}

/** Remarque de sécurité signalée uniquement par le résumé Codex. */
function securitySummaryApi() {
  const api = S.cleanApi();
  api.issueComments = [S.summaryComment({ unresolved: false,
    security: { commit_sha: HEAD, has_any_findings: true, has_unresolved_findings: true, status: 'completed' } })];
  return api;
}

/**
 * Scénario : { name, eventName, payload, api, apiAtRecheck?, permission, seen?, trustedActor?, expected }.
 * `apiAtRecheck` simule un changement entre la première lecture et la revérification.
 */
function scenarios() {
  const ev = S.summaryEvent();
  const manual = { inputs: { pr_number: '7' } };
  return [
    { name: 'positif : remarque P2 non résolue sur le SHA courant', eventName: 'issue_comment', payload: ev, api: S.findingApi(),
      permission: 'admin', expected: { status: 'HANDOFF_READY', reason: 'CONFIRMED_FINDINGS_HANDOFF_PREPARED' } },
    { name: 'positif : anomalie de sécurité signalée par le résumé', eventName: 'issue_comment', payload: ev, api: securitySummaryApi(),
      permission: 'write', expected: { status: 'HANDOFF_READY', reason: 'CONFIRMED_FINDINGS_HANDOFF_PREPARED' } },
    { name: 'positif : lancement manuel par le propriétaire', eventName: 'workflow_dispatch', payload: manual, api: S.findingApi(),
      permission: 'admin', trustedActor: true, expected: { status: 'HANDOFF_READY', reason: 'CONFIRMED_FINDINGS_HANDOFF_PREPARED' } },
    { name: 'négatif : revue Codex propre', eventName: 'issue_comment', payload: ev, api: S.cleanApi(), permission: 'admin',
      expected: { status: 'NO_HANDOFF', reason: 'NO_FINDINGS_ON_HEAD' } },
    { name: 'revue Codex en cours (résumé partiel)', eventName: 'issue_comment', payload: ev, permission: 'admin',
      api: S.cleanApi({ status: 'running', unresolved: null }), expected: { status: 'UNVERIFIED', reason: 'REVIEW_IN_PROGRESS' } },
    { name: 'dossier déjà publié (doublon)', eventName: 'issue_comment', payload: ev, api: S.findingApi(), permission: 'admin',
      seen: true, expected: { status: 'NO_HANDOFF', reason: 'DUPLICATE_HANDOFF' } },
    { name: 'revue sur un SHA obsolète', eventName: 'issue_comment', payload: ev, permission: 'admin',
      api: (() => { const a = S.findingApi(); a.pr = S.pullRequest({ sha: NEW_HEAD }); return a; })(),
      expected: { status: 'NO_HANDOFF', reason: 'REVIEW_ON_STALE_SHA' } },
    { name: 'SHA modifié avant la préparation', eventName: 'issue_comment', payload: ev, api: S.findingApi(), permission: 'admin',
      apiAtRecheck: S.findingApi({ sha: NEW_HEAD }), expected: { status: 'UNVERIFIED', reason: 'HEAD_SHA_CHANGED' } },
    { name: 'remarque résolue avant la préparation', eventName: 'issue_comment', payload: ev, api: S.findingApi(), permission: 'admin',
      apiAtRecheck: (() => { const a = S.findingApi({ unresolved: false }); a.threads = { 701: { isResolved: true, isOutdated: false } }; return a; })(),
      expected: { status: 'NO_HANDOFF', reason: 'FINDINGS_RESOLVED' } },
    { name: 'PR issue d\'un fork', eventName: 'issue_comment', payload: ev, permission: 'admin',
      api: S.findingApi({ headRepo: { full_name: 'mallory/TestDoubleIA', fork: true } }),
      expected: { status: 'NO_HANDOFF', reason: 'HEAD_REPO_NOT_ALLOWED' } },
    { name: 'PR fermée', eventName: 'issue_comment', payload: ev, permission: 'admin', api: S.findingApi({ state: 'closed' }),
      expected: { status: 'NO_HANDOFF', reason: 'PR_NOT_OPEN' } },
    { name: 'branche source non autorisée', eventName: 'issue_comment', payload: ev, permission: 'admin',
      api: S.findingApi({ ref: 'feature/x' }), expected: { status: 'NO_HANDOFF', reason: 'BRANCH_NOT_ALLOWED' } },
    { name: 'auteur de PR sans droit d\'écriture', eventName: 'issue_comment', payload: ev, permission: 'read',
      api: S.findingApi({ user: OUTSIDER }), expected: { status: 'NO_HANDOFF', reason: 'AUTHOR_NOT_TRUSTED' } },
    { name: 'commentaire tiers imitant Codex', eventName: 'issue_comment', permission: 'admin', api: S.findingApi(),
      payload: S.summaryEvent({ sender: OUTSIDER, comment: S.summaryComment({ user: OUTSIDER }) }),
      expected: { status: 'NO_HANDOFF', reason: 'TRIGGER_NOT_FROM_CODEX' } },
    { name: 'résumé Codex édité par un humain', eventName: 'issue_comment', permission: 'admin', api: S.findingApi(),
      payload: S.summaryEvent({ sender: OWNER }), expected: { status: 'NO_HANDOFF', reason: 'SENDER_NOT_CODEX' } },
    { name: 'lien de remarque malveillant', eventName: 'issue_comment', payload: ev, permission: 'admin',
      api: maliciousUrlApi(`https://github.com/${REPO}/pull/8#discussion_r701`),
      expected: { status: 'UNVERIFIED', reason: 'FINDING_URL_UNVERIFIED' } },
    { name: 'lancement manuel par un tiers', eventName: 'workflow_dispatch', payload: manual, api: S.findingApi(),
      permission: 'admin', trustedActor: false, expected: { status: 'NO_HANDOFF', reason: 'ACTOR_NOT_OWNER' } }
  ];
}

/** Exécute un scénario sans réseau. Retourne le résultat de prepare(). */
async function simulate(sc) {
  let reads = 0;
  return H.prepare({
    eventName: sc.eventName, payload: clone(sc.payload), repo: sc.repo || REPO, trustedActor: sc.trustedActor === true,
    loadApi: async () => {
      reads += 1;
      if (sc.apiError) throw sc.apiError;
      return clone(reads > 1 && sc.apiAtRecheck ? sc.apiAtRecheck : sc.api);
    },
    loadPermission: async () => sc.permission,
    hasHandoff: async () => {
      if (sc.seenError) throw sc.seenError;
      return sc.seen === true;
    }
  });
}

module.exports = { REPO, HEAD, NEW_HEAD, CODEX_USER, OWNER, OUTSIDER, maliciousUrlApi, securitySummaryApi, scenarios, simulate };
