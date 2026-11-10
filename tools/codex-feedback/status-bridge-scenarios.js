/*
 * Scénarios simulés de la passerelle Codex → statut GitHub (Issue #17).
 * Utilisés par la démonstration hors ligne (BRIDGE_PHASE=demo) et par
 * tests/codex-status-bridge.test.js. Aucun appel réseau.
 */
'use strict';

const S = require('./gate-scenarios.js');
const B = require('./status-bridge.js');

const { HEAD, NEW_HEAD, OWNER, OUTSIDER, CODEX_USER } = S;
const OLD_SHA = 'b'.repeat(40);
const SHA_D = 'd'.repeat(40);
const SHA_E = 'e'.repeat(40);

/** Statut déjà présent sur un SHA (publié par la passerelle, sauf `ours: false`). */
function prior(state, ours = true) {
  return { state, context: B.CONTEXT, description: B.DESCRIPTIONS[state], ours };
}

/** Revue propre sur le SHA courant, mais section sécurité restée sur un ancien SHA (revue partielle). */
function partialApi() {
  const api = S.cleanApi();
  api.issueComments = [S.summaryComment({ unresolved: false,
    security: { commit_sha: OLD_SHA, has_any_findings: false, has_unresolved_findings: false, status: 'completed' } })];
  return api;
}

/** Remarque Codex sur le SHA courant, mais fil marqué résolu ; résumé final propre. */
function resolvedApi() {
  const api = S.findingApi();
  api.issueComments = [S.summaryComment({ unresolved: false })];
  api.threads = { 701: { isResolved: true, isOutdated: false } };
  return api;
}

/** Revue Codex faite sur un ancien SHA ; la PR a avancé depuis. */
function staleApi() {
  const api = S.findingApi();
  api.pr = S.pullRequest({ sha: NEW_HEAD });
  return api;
}

/** Remarques sur deux SHA précédents et sur le SHA courant : 3e cycle → limite atteinte. */
function cycleLimitApi() {
  const api = S.findingApi();
  for (const [i, sha] of [SHA_D, SHA_E].entries()) {
    api.reviews.push({ id: 810 + i, user: CODEX_USER, commit_id: sha, state: 'COMMENTED', body: S.HOSTILE });
    api.reviewComments.push(S.inlineComment({ id: 710 + i, reviewId: 810 + i, sha }));
    api.threads[710 + i] = { isResolved: false, isOutdated: true };
  }
  return api;
}

function scenarios() {
  const ev = S.summaryEvent();
  const common = { eventName: 'issue_comment', payload: ev, permission: 'admin' };
  return [
    { ...common, name: 'remarque P2 non résolue sur le SHA courant → failure', api: S.findingApi(),
      expected: { decision: 'PUBLISHED', reason: 'STATUS_FAILURE_PUBLISHED', writes: 'failure' } },
    { ...common, name: 'revue complète propre → success', api: S.cleanApi(),
      expected: { decision: 'PUBLISHED', reason: 'STATUS_SUCCESS_PUBLISHED', writes: 'success' } },
    { ...common, name: 'nouvelle revue propre après failure → restauration success', api: S.cleanApi(),
      initialStatuses: { [HEAD]: [prior('failure')] },
      expected: { decision: 'PUBLISHED', reason: 'STATUS_SUCCESS_PUBLISHED', writes: 'success' } },
    { ...common, name: 'fils résolus et résumé propre → success', api: resolvedApi(),
      expected: { decision: 'PUBLISHED', reason: 'STATUS_SUCCESS_PUBLISHED', writes: 'success' } },
    { ...common, name: 'résumé édité, failure déjà publié → aucun doublon', api: S.findingApi(),
      initialStatuses: { [HEAD]: [prior('failure')] },
      expected: { decision: 'SKIP', reason: 'ALREADY_PUBLISHED' } },
    { ...common, name: 'revue en cours, aucun statut existant → rien', api: S.cleanApi({ status: 'running', unresolved: null }),
      expected: { decision: 'SKIP', reason: 'NOTHING_TO_SUSPEND' } },
    { ...common, name: 'revue relancée après success → suspension pending', api: S.cleanApi({ status: 'running', unresolved: null }),
      initialStatuses: { [HEAD]: [prior('success')] },
      expected: { decision: 'PUBLISHED', reason: 'STATUS_PENDING_PUBLISHED', writes: 'pending' } },
    { ...common, name: 'revue partielle (section sur ancien SHA) → pas de success', api: partialApi(),
      expected: { decision: 'SKIP', reason: 'NOTHING_TO_SUSPEND' } },
    { ...common, name: 'revue sur un SHA obsolète → rien', api: staleApi(),
      expected: { decision: 'SKIP', reason: 'REVIEW_ON_STALE_SHA' } },
    { ...common, name: 'limite de 2 cycles atteinte → rien (pas de boucle)', api: cycleLimitApi(),
      expected: { decision: 'SKIP', reason: 'CYCLE_LIMIT_REACHED' } },
    { ...common, name: 'SHA modifié juste avant l\'écriture', api: S.findingApi(), prAtWrite: S.pullRequest({ sha: NEW_HEAD }),
      expected: { decision: 'SKIP', reason: 'STALE_SHA' } },
    { ...common, name: 'verdict changé entre analyse et publication', api: S.findingApi(), apiAtPublish: S.cleanApi(),
      expected: { decision: 'SKIP', reason: 'VERDICT_CHANGED' } },
    { ...common, name: 'interrupteur CODEX_STATUS_BRIDGE_ENABLED absent', api: S.findingApi(), enabled: false,
      expected: { decision: 'SKIP', reason: 'BRIDGE_DISABLED' } },
    { ...common, name: 'commentaire tiers imitant Codex', api: S.findingApi(),
      payload: S.summaryEvent({ sender: OUTSIDER, comment: S.summaryComment({ user: OUTSIDER }) }),
      expected: { decision: 'SKIP', reason: 'TRIGGER_NOT_FROM_CODEX' } },
    { ...common, name: 'résumé Codex édité par un humain', api: S.findingApi(), payload: S.summaryEvent({ sender: OWNER }),
      expected: { decision: 'SKIP', reason: 'SENDER_NOT_CODEX' } },
    { ...common, name: 'PR issue d\'un fork', api: S.findingApi({ headRepo: { full_name: 'mallory/TestDoubleIA', fork: true } }),
      expected: { decision: 'SKIP', reason: 'HEAD_REPO_NOT_ALLOWED' } },
    { ...common, name: 'branche source hors claude/*', api: S.findingApi({ ref: 'feature/x' }),
      expected: { decision: 'SKIP', reason: 'BRANCH_NOT_ALLOWED' } },
    { ...common, name: 'PR fermée', api: S.findingApi({ state: 'closed' }),
      expected: { decision: 'SKIP', reason: 'PR_NOT_OPEN' } },
    { ...common, name: 'auteur de PR sans droit d\'écriture', api: S.findingApi({ user: OUTSIDER }), permission: 'read',
      expected: { decision: 'SKIP', reason: 'AUTHOR_NOT_TRUSTED' } },
    { ...common, name: 'label d\'arrêt codex-gate:stop', api: S.findingApi({ labels: [{ name: 'codex-gate:stop' }] }),
      expected: { decision: 'SKIP', reason: 'STOPPED_BY_LABEL' } }
  ];
}

module.exports = { OLD_SHA, prior, partialApi, resolvedApi, staleApi, cycleLimitApi, scenarios };
