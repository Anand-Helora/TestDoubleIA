#!/usr/bin/env node
/*
 * Passerelle expérimentale Codex → statut de commit GitHub (Issue #17).
 *
 * HYPOTHÈSE NON PROUVÉE : Claude Code Web Auto-fix réagit à un statut de commit `failure`
 * publié via l'API par GitHub Actions comme à une CI rouge. Ce script ne fait que publier
 * (ou non) un statut ; il n'appelle ni Claude ni aucune API d'IA, n'utilise aucun secret,
 * ne modifie aucun fichier, aucune branche, aucune ref et ne crée aucune réservation B1.
 *
 * Statut publié (contexte `codex/verified-review`, sur le SHA DE TÊTE DE LA PR) :
 *   failure   remarques Codex non résolues confirmées sur le SHA courant (détecteur phase A)
 *   success   revue Codex complète sur le SHA courant, sans remarque non résolue
 *   pending   revue incomplète / ambiguë alors qu'un statut success ou failure existe déjà
 *             sur ce SHA : il est suspendu pour ne pas rester trompeur
 * Dans tous les autres cas, rien n'est écrit. Les descriptions sont des constantes.
 *
 * Phases (variable BRIDGE_PHASE) :
 *   analyze  lecture seule : événement + API → cible proposée (failure | success | pending)
 *   publish  revérifie tout via l'API juste avant d'écrire, puis publie au plus un statut
 *            (uniquement si CODEX_STATUS_BRIDGE_ENABLED === 'true')
 *   demo     scénarios simulés hors ligne, aucun appel réseau
 * Documentation : docs/codex-status-bridge.md
 */
'use strict';

const fs = require('node:fs');
const D = require('./detect.js');
const G = require('./gate.js');

const CONTEXT = 'codex/verified-review';
const BRIDGE = Object.freeze({
  ELIGIBLE: 'ELIGIBLE',     // analyse : cible proposée, publication possible si activée
  PUBLISHED: 'PUBLISHED',   // publication : statut écrit
  SKIP: 'SKIP',
  UNVERIFIED: 'UNVERIFIED'
});
const TARGETS = ['failure', 'success', 'pending'];
/** Descriptions statiques (≤ 140 caractères), jamais dérivées d'un commentaire. */
const DESCRIPTIONS = Object.freeze({
  failure: 'Codex : remarques non résolues confirmées sur ce commit',
  success: 'Codex : revue complète sans remarque non résolue sur ce commit',
  pending: 'Codex : revue incomplète ou non vérifiable, statut suspendu'
});
/** Créateur attendu des statuts publiés avec le GITHUB_TOKEN. */
const ACTIONS_BOT = Object.freeze({ login: 'github-actions[bot]', id: 41898282, type: 'Bot' });
/** Raisons du détecteur pour lesquelles la revue est incomplète ou incertaine → pending. */
const SUSPEND_REASONS = ['REVIEW_IN_PROGRESS', 'SUMMARY_AMBIGUOUS', 'CONTRADICTORY_SIGNALS',
  'FINDING_STATUS_UNKNOWN', 'SUMMARY_STATE_UNREADABLE'];
const SHA_RE = /^[0-9a-f]{40}$/;
const PR_RE = /^[1-9][0-9]{0,9}$/;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const RUN_RE = /^[1-9][0-9]{0,19}$/;

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Décision (fonctions pures)
// ---------------------------------------------------------------------------

/**
 * Vrai seulement si le résumé Codex qui fait foi est entièrement terminé sur le SHA courant :
 * chaque section exécutée porte ce SHA, est `completed` et indique explicitement
 * `has_unresolved_findings: false`. Une section restée sur un ancien SHA = revue partielle.
 */
function summaryCompleteOnHead(api, headSha) {
  if (!isObject(api) || !SHA_RE.test(String(headSha))) return false;
  const summary = D.latestCodexSummary(api.issueComments);
  const state = summary ? D.parseReviewState(summary.body) : null;
  if (!state || state.error) return false;
  const sections = Object.values(state.sections);
  return sections.length > 0 &&
    sections.every((s) => s.commitSha === headSha && s.status === 'completed' && s.unresolved === false);
}

/**
 * Détection Codex (detect.js) → cible du statut.
 * Retourne { target: 'failure' | 'success' | 'pending' | null, reason }.
 */
function decideTarget(detection, api) {
  if (!isObject(detection)) return { target: null, reason: 'DETECTION_MISSING' };
  const reason = detection.reason;
  if (detection.decision === D.DECISION.FIX) return { target: 'failure', reason: 'CONFIRMED_UNRESOLVED_FINDINGS_ON_HEAD' };
  if (detection.decision === D.DECISION.UNVERIFIED) {
    return SUSPEND_REASONS.includes(reason) ? { target: 'pending', reason } : { target: null, reason };
  }
  if (reason === 'NO_FINDINGS_ON_HEAD' || reason === 'FINDINGS_RESOLVED') {
    return summaryCompleteOnHead(api, detection.headSha)
      ? { target: 'success', reason: 'CLEAN_COMPLETE_REVIEW_ON_HEAD' }
      : { target: 'pending', reason: 'REVIEW_PARTIAL_ON_HEAD' };
  }
  // CYCLE_LIMIT_REACHED, REVIEW_ON_STALE_SHA, NO_CODEX_REVIEW, PR_NOT_OPEN… : aucune écriture.
  return { target: null, reason };
}

/** target_url : uniquement le récapitulatif de l'exécution, ou à défaut la PR, sur github.com. */
function targetUrl(repo, runId, prNumber) {
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) return null;
  if (typeof runId === 'string' && RUN_RE.test(runId)) return `https://github.com/${repo}/actions/runs/${runId}`;
  if (Number.isSafeInteger(prNumber) && prNumber > 0) return `https://github.com/${repo}/pull/${prNumber}`;
  return null;
}

/** Corps exact de la requête POST /statuses/{sha} (aucune valeur non fiable). */
function statusPayload(target, url) {
  if (!TARGETS.includes(target)) throw new Error('cible de statut invalide');
  return { state: target, context: CONTEXT, description: DESCRIPTIONS[target], ...(url ? { target_url: url } : {}) };
}

function isActionsBot(user) {
  return isObject(user) && user.login === ACTIONS_BOT.login && user.id === ACTIONS_BOT.id && user.type === ACTIONS_BOT.type;
}

/**
 * Faut-il écrire, compte tenu du dernier statut de notre contexte sur ce SHA ?
 * `latest` : { state, description, ours } ou null (aucun statut connu).
 */
function writeNeeded(target, latest) {
  if (target === 'pending') {
    // Suspendre seulement un verdict existant ; sinon ne rien créer.
    if (!latest || (latest.state !== 'success' && latest.state !== 'failure')) return { write: false, reason: 'NOTHING_TO_SUSPEND' };
    return { write: true };
  }
  if (latest && latest.ours && latest.state === target && latest.description === DESCRIPTIONS[target]) {
    return { write: false, reason: 'ALREADY_PUBLISHED' };
  }
  return { write: true, ...(latest && !latest.ours ? { note: 'FOREIGN_STATUS_REPLACED' } : {}) };
}

// ---------------------------------------------------------------------------
// Évaluation d'une PR (chargeurs injectables : API réelle ou simulation)
// ---------------------------------------------------------------------------

/**
 * Relit la PR et la revue Codex, applique les garde-fous de la passerelle B1
 * (même dépôt, non fork, branche claude/*, label d'arrêt, auteur admin/write)
 * et calcule la cible. Aucune écriture.
 */
async function assessPr(trigger, { repo, loadApi, loadPermission }) {
  const base = { prNumber: trigger.prNumber, target: null };
  const out = (decision, reason, extra = {}) => ({ ...base, decision, reason, ...extra });
  const api = await loadApi(trigger.prNumber);
  if (!isObject(api) || !isObject(api.pr) || api.pr.number !== trigger.prNumber) return out(BRIDGE.UNVERIFIED, 'PR_DATA_INCOMPLETE');
  const detection = D.analyze(trigger, api, { seenKeys: new Set() });
  const detected = { headSha: detection.headSha || null, detection: { decision: detection.decision, reason: detection.reason } };
  const prProblem = G.checkPullRequest(api.pr, repo);
  if (prProblem) return out(prProblem.decision === G.GATE.SKIP ? BRIDGE.SKIP : BRIDGE.UNVERIFIED, prProblem.reason, detected);
  if (detection.headSha !== api.pr.head.sha) return out(BRIDGE.UNVERIFIED, 'API_DATA_INVALID', detected);
  const permProblem = G.checkPermission(await loadPermission(api.pr.user.login));
  if (permProblem) return out(permProblem.decision === G.GATE.SKIP ? BRIDGE.SKIP : BRIDGE.UNVERIFIED, permProblem.reason, detected);
  const { target, reason } = decideTarget(detection, api);
  if (!target) return out(detection.decision === D.DECISION.UNVERIFIED ? BRIDGE.UNVERIFIED : BRIDGE.SKIP, reason, detected);
  const findingUrls = (detection.findings || []).map((f) => f.url).filter(Boolean);
  return out(BRIDGE.ELIGIBLE, reason, { ...detected, target, findingUrls });
}

function errorReason(e) { return e && e.rateLimited ? 'API_RATE_LIMITED' : 'API_ERROR'; }
function errorNote(e) { return e && Number.isInteger(e.status) && e.status > 0 ? `HTTP_${e.status}` : 'NETWORK_ERROR'; }

/** Étape d'analyse (lecture seule). */
async function analyzeStage({ eventName, payload, enabled, repo, loadApi, loadPermission }) {
  const early = (decision, reason, prNumber = null) => ({ stage: 'analyze', prNumber, target: null, eligible: false, decision, reason });
  if (eventName !== 'issue_comment' && eventName !== 'workflow_dispatch') return early(BRIDGE.SKIP, 'UNSUPPORTED_EVENT');
  const trigger = D.readTrigger(eventName, payload);
  if (trigger.stop) {
    return early(trigger.stop.decision === D.DECISION.UNVERIFIED ? BRIDGE.UNVERIFIED : BRIDGE.SKIP, trigger.stop.reason,
      trigger.stop.prNumber || null);
  }
  // Un humain qui édite le résumé Codex n'est pas Codex : vérifié avant tout appel API.
  if (eventName === 'issue_comment' && !D.isCodexUser(payload.sender)) return early(BRIDGE.SKIP, 'SENDER_NOT_CODEX', trigger.prNumber);

  let a;
  try { a = await assessPr(trigger, { repo, loadApi, loadPermission }); } catch (e) {
    return { ...early(BRIDGE.UNVERIFIED, errorReason(e), trigger.prNumber), notes: [errorNote(e)] };
  }
  const result = { stage: 'analyze', eligible: false, ...a };
  if (a.decision !== BRIDGE.ELIGIBLE) return result;
  if (trigger.manual) return { ...result, decision: BRIDGE.SKIP, reason: 'MANUAL_EVALUATION_ONLY', wouldPublish: a.target };
  if (!enabled) return { ...result, decision: BRIDGE.SKIP, reason: 'BRIDGE_DISABLED', wouldPublish: a.target };
  return { ...result, eligible: true };
}

/**
 * Étape de publication. Ne reçoit que des valeurs validées (n° de PR, SHA, cible),
 * relit et réévalue TOUT via l'API, vérifie que la cible et le SHA n'ont pas changé,
 * évite les doublons, revérifie le SHA juste avant d'écrire, puis publie un statut.
 */
async function publishStage({ input, enabled, repo, loadApi, loadPermission, loadPr, statuses, meta = {} }) {
  const base = { stage: 'publish', prNumber: null, context: CONTEXT };
  const out = (decision, reason, extra = {}) => ({ ...base, decision, reason, ...extra });
  const prNumber = typeof input.prNumber === 'string' && PR_RE.test(input.prNumber) ? Number(input.prNumber) : null;
  if (!prNumber || typeof input.headSha !== 'string' || !SHA_RE.test(input.headSha) || !TARGETS.includes(input.target)) {
    return out(BRIDGE.UNVERIFIED, 'INVALID_INPUT');
  }
  Object.assign(base, { prNumber, headSha: input.headSha, target: input.target });
  if (!enabled) return out(BRIDGE.SKIP, 'BRIDGE_DISABLED');

  try {
    const trigger = { prNumber, eventName: 'issue_comment', action: 'recheck', manual: false };
    const a = await assessPr(trigger, { repo, loadApi, loadPermission });
    if (a.headSha && a.headSha !== input.headSha) return out(BRIDGE.SKIP, 'STALE_SHA', { currentSha: a.headSha });
    if (a.decision !== BRIDGE.ELIGIBLE) return out(a.decision, a.reason, { notes: ['RECHECK_BEFORE_PUBLISH'] });
    if (a.target !== input.target) return out(BRIDGE.SKIP, 'VERDICT_CHANGED', { currentTarget: a.target });

    const latest = await statuses.latest(input.headSha);
    const need = writeNeeded(input.target, latest);
    if (!need.write) return out(BRIDGE.SKIP, need.reason, { previous: latest ? latest.state : null });

    // Dernière vérification, immédiatement avant l'écriture : PR toujours ouverte, SHA inchangé.
    const pr = await loadPr(prNumber);
    if (!isObject(pr) || !isObject(pr.head) || pr.state !== 'open') return out(BRIDGE.SKIP, 'PR_NOT_OPEN');
    if (pr.head.sha !== input.headSha) return out(BRIDGE.SKIP, 'STALE_SHA', { currentSha: SHA_RE.test(String(pr.head.sha)) ? pr.head.sha : null });

    const payload = statusPayload(input.target, targetUrl(repo, meta.runId, prNumber));
    await statuses.create(input.headSha, payload);
    return out(BRIDGE.PUBLISHED, `STATUS_${input.target.toUpperCase()}_PUBLISHED`,
      { previous: latest ? latest.state : null, ...(need.note ? { notes: [need.note] } : {}) });
  } catch (e) {
    return out(BRIDGE.UNVERIFIED, errorReason(e), { notes: [errorNote(e), 'NOTHING_PUBLISHED'] });
  }
}

// ---------------------------------------------------------------------------
// Accès aux statuts de commit
// ---------------------------------------------------------------------------

/** Statuts via l'API GitHub : lecture du dernier statut du contexte, création. */
class GitHubStatuses {
  constructor(ctx) { this.ctx = ctx; }

  async request(method, pathname, body) {
    const res = await this.ctx.fetch(`${this.ctx.apiUrl}/repos/${this.ctx.repo}${pathname}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.ctx.token}`, 'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { status: res.status, ok: res.ok, data };
  }

  /** Dernier statut du contexte sur ce SHA (l'API les renvoie du plus récent au plus ancien). */
  async latest(sha) {
    if (!SHA_RE.test(String(sha))) throw new Error('SHA invalide');
    const r = await this.request('GET', `/commits/${sha}/statuses?per_page=100`);
    if (r.status === 404) return null;
    if (!r.ok || !Array.isArray(r.data)) throw new G.GateApiError(r.status, `lecture des statuts impossible (HTTP ${r.status})`);
    const s = r.data.find((x) => isObject(x) && x.context === CONTEXT);
    return s ? { state: String(s.state), description: String(s.description), ours: isActionsBot(s.creator) } : null;
  }

  async create(sha, payload) {
    if (!SHA_RE.test(String(sha))) throw new Error('SHA invalide');
    const r = await this.request('POST', `/statuses/${sha}`, payload);
    if (r.status !== 201) throw new G.GateApiError(r.status, `publication du statut refusée (HTTP ${r.status})`);
  }
}

/** Statuts simulés en mémoire (tests et démonstration). `writes` liste toutes les écritures. */
class MemoryStatuses {
  constructor({ initial = {}, fail = null } = {}) {
    this.bySha = new Map(Object.entries(initial).map(([sha, list]) => [sha, [...list]]));
    this.writes = [];
    this.fail = fail;
  }

  async latest(sha) {
    if (this.fail && this.fail('latest')) throw this.fail('latest');
    const list = this.bySha.get(sha) || [];
    const s = list.filter((x) => x.context === CONTEXT).slice(-1)[0];
    return s ? { state: s.state, description: s.description, ours: s.ours !== false } : null;
  }

  async create(sha, payload) {
    if (this.fail && this.fail('create')) throw this.fail('create');
    this.writes.push({ sha, ...payload });
    if (!this.bySha.has(sha)) this.bySha.set(sha, []);
    this.bySha.get(sha).push({ ...payload, ours: true });
  }
}

/** Chaîne complète sur un scénario simulé (analyse puis publication), sans réseau. */
async function simulate(sc, statuses = new MemoryStatuses()) {
  const repo = sc.repo || 'Anand-Helora/TestDoubleIA';
  const enabled = sc.enabled !== false;
  const loadPermission = async () => sc.permission;
  const analysis = await analyzeStage({ eventName: sc.eventName, payload: sc.payload, enabled, repo,
    loadApi: async () => { if (sc.apiError) throw sc.apiError; return sc.api; }, loadPermission });
  if (!analysis.eligible) return { analysis, final: analysis, statuses };
  const apiAtPublish = sc.apiAtPublish || sc.api;
  const final = await publishStage({
    input: { prNumber: String(analysis.prNumber), headSha: analysis.headSha, target: analysis.target },
    enabled, repo, statuses, meta: { runId: sc.runId || '1234' }, loadPermission,
    loadApi: async () => { if (sc.publishApiError) throw sc.publishApiError; return apiAtPublish; },
    loadPr: async () => sc.prAtWrite || apiAtPublish.pr
  });
  return { analysis, final, statuses };
}

// ---------------------------------------------------------------------------
// Sortie : uniquement des énumérations, nombres, SHA et liens validés
// ---------------------------------------------------------------------------

const clean = D.clean;
const TITLE = 'Codex status bridge (expérimental)';

function renderSummary(r) {
  const lines = [
    `## ${TITLE}`, '', '| Champ | Valeur |', '| --- | --- |',
    `| Étape | ${clean(r.stage || '—')} |`,
    `| Décision | **${clean(r.decision)}** |`,
    `| Raison | \`${clean(r.reason)}\` |`,
    `| PR | ${r.prNumber ? '#' + clean(r.prNumber) : '—'} |`,
    `| SHA de tête | ${r.headSha ? '`' + clean(r.headSha) + '`' : '—'} |`,
    `| Contexte | \`${CONTEXT}\` |`
  ];
  if (r.target) lines.push(`| Statut visé | ${clean(r.target)} |`);
  if (r.wouldPublish) lines.push(`| Statut qui serait publié | ${clean(r.wouldPublish)} (aucune écriture dans ce mode) |`);
  if (r.previous) lines.push(`| Statut précédent | ${clean(r.previous)} |`);
  if (r.detection) lines.push(`| Détection Codex | ${clean(r.detection.decision)} / \`${clean(r.detection.reason)}\` |`);
  if (r.notes && r.notes.length) lines.push(`| Notes | ${r.notes.map(clean).join(', ')} |`);
  if (r.findingUrls && r.findingUrls.length) {
    lines.push('', '### Remarques Codex', '', ...r.findingUrls.map((u, i) => `- [remarque ${i + 1}](${u})`));
  }
  lines.push('', '_Hypothèse expérimentale : aucun appel à Claude, aucun secret, aucune modification de code ni fusion._', '');
  return lines.join('\n');
}

function emit(result, env, deps) {
  const out = deps.out || ((s) => process.stdout.write(s + '\n'));
  const write = deps.appendFile || fs.appendFileSync;
  out(`::notice title=${TITLE}::${clean(result.stage)} — ${clean(result.decision)} — ${clean(result.reason)}` +
    (result.prNumber ? ` — PR #${clean(result.prNumber)}` : ''));
  out(JSON.stringify(result));
  if (env.GITHUB_STEP_SUMMARY) write(env.GITHUB_STEP_SUMMARY, renderSummary(result) + '\n');
  if (env.GITHUB_OUTPUT) {
    const lines = [`decision=${clean(result.decision)}`, `reason=${clean(result.reason)}`, `eligible=${result.eligible === true}`];
    if (result.eligible === true && Number.isSafeInteger(result.prNumber) && SHA_RE.test(String(result.headSha)) &&
        TARGETS.includes(result.target)) {
      lines.push(`pr_number=${result.prNumber}`, `head_sha=${result.headSha}`, `target=${result.target}`);
    }
    write(env.GITHUB_OUTPUT, lines.join('\n') + '\n');
  }
}

// ---------------------------------------------------------------------------
// Exécution
// ---------------------------------------------------------------------------

function githubContext(env, deps) {
  if (!env.GITHUB_TOKEN || !REPO_RE.test(env.GITHUB_REPOSITORY || '')) return null;
  return {
    repo: env.GITHUB_REPOSITORY,
    token: env.GITHUB_TOKEN,
    apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
    graphqlUrl: env.GITHUB_GRAPHQL_URL || 'https://api.github.com/graphql',
    fetch: G.guardedFetch(deps.fetch || globalThis.fetch)
  };
}

async function loadPermissionFrom(ctx, login) {
  if (typeof login !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) return 'none';
  const st = new GitHubStatuses(ctx);
  const r = await st.request('GET', `/collaborators/${login}/permission`);
  if (r.status === 404) return 'none';
  if (!r.ok || !isObject(r.data) || typeof r.data.permission !== 'string') {
    throw new G.GateApiError(r.status, `lecture des droits impossible (HTTP ${r.status})`);
  }
  return r.data.permission;
}

async function loadPrFrom(ctx, number) {
  const r = await new GitHubStatuses(ctx).request('GET', `/pulls/${number}`);
  if (!r.ok) throw new G.GateApiError(r.status, `lecture de la PR impossible (HTTP ${r.status})`);
  return r.data;
}

async function run(env, deps = {}) {
  const phase = env.BRIDGE_PHASE;
  // Interrupteur dédié : seule la valeur exacte 'true' autorise une écriture.
  const enabled = env.CODEX_STATUS_BRIDGE_ENABLED === 'true';
  const runId = RUN_RE.test(env.GITHUB_RUN_ID || '') ? env.GITHUB_RUN_ID : null;
  let result;

  if (phase === 'demo') {
    const S = require('./status-bridge-scenarios.js');
    const out = deps.out || ((s) => process.stdout.write(s + '\n'));
    const rows = [];
    let ok = true;
    for (const sc of S.scenarios()) {
      const { final, statuses } = await simulate(sc, new MemoryStatuses({ initial: sc.initialStatuses || {} }));
      const written = statuses.writes.map((w) => w.state).join('+') || '—';
      const pass = final.decision === sc.expected.decision && final.reason === sc.expected.reason &&
        written === (sc.expected.writes || '—');
      ok = ok && pass;
      rows.push(`| ${clean(sc.name)} | ${clean(final.decision)} | \`${clean(final.reason)}\` | ${clean(written)} | ${pass ? 'oui' : '**NON**'} |`);
      out(`::notice title=${TITLE} (démo)::${clean(sc.name)} — ${clean(final.decision)} — ${clean(final.reason)}`);
    }
    const md = [`## ${TITLE} — démonstration hors ligne`, '', '| Scénario | Décision | Raison | Statut écrit | Conforme |',
      '| --- | --- | --- | --- | --- |', ...rows, '', '_Statuts simulés en mémoire, aucun appel réseau._', ''].join('\n');
    if (env.GITHUB_STEP_SUMMARY) (deps.appendFile || fs.appendFileSync)(env.GITHUB_STEP_SUMMARY, md + '\n');
    if (!ok) { out(`::error title=${TITLE} (démo)::résultat non conforme`); process.exitCode = 1; }
    return { ok, rows };
  }

  const ctx = githubContext(env, deps);
  if (phase === 'analyze') {
    const eventName = env.GITHUB_EVENT_NAME;
    let payload = null;
    try { payload = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')); } catch (e) { payload = null; }
    if (!ctx) {
      const pre = await analyzeStage({ eventName, payload, enabled, repo: '',
        loadApi: async () => { throw new Error('contexte'); }, loadPermission: async () => undefined });
      result = pre.reason === 'API_ERROR' ? { ...pre, reason: 'MISSING_CONTEXT', notes: [] } : pre;
    } else {
      result = await analyzeStage({ eventName, payload, enabled, repo: ctx.repo,
        loadApi: (n) => D.fetchApiData(n, ctx), loadPermission: (login) => loadPermissionFrom(ctx, login) });
    }
  } else if (phase === 'publish') {
    const input = { prNumber: env.BRIDGE_PR_NUMBER, headSha: env.BRIDGE_HEAD_SHA, target: env.BRIDGE_TARGET };
    if (!ctx) {
      result = { stage: 'publish', prNumber: null, decision: BRIDGE.UNVERIFIED, reason: 'MISSING_CONTEXT' };
    } else {
      result = await publishStage({ input, enabled, repo: ctx.repo, meta: { runId },
        statuses: deps.statuses || new GitHubStatuses(ctx),
        loadApi: (n) => D.fetchApiData(n, ctx), loadPr: (n) => loadPrFrom(ctx, n),
        loadPermission: (login) => loadPermissionFrom(ctx, login) });
    }
  } else {
    result = { stage: 'none', decision: BRIDGE.UNVERIFIED, reason: 'UNKNOWN_PHASE' };
  }
  emit(result, env, deps);
  return result;
}

module.exports = {
  CONTEXT, BRIDGE, TARGETS, DESCRIPTIONS, ACTIONS_BOT, SUSPEND_REASONS,
  summaryCompleteOnHead, decideTarget, targetUrl, statusPayload, isActionsBot, writeNeeded,
  assessPr, analyzeStage, publishStage, GitHubStatuses, MemoryStatuses, simulate, renderSummary, run
};

if (require.main === module) {
  run({ ...process.env }).catch((e) => {
    process.stdout.write(`::error title=${TITLE}::erreur interne ${clean(e && e.message)}\n`);
    process.exitCode = 1;
  });
}
