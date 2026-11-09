#!/usr/bin/env node
/*
 * Passerelle de décision Codex → Claude (Issue #9, phase B1).
 *
 * N'APPELLE NI CLAUDE NI L'API ANTHROPIC et n'utilise aucun secret. La passerelle :
 *   1. réévalue la revue Codex via l'API GitHub et le détecteur existant (detect.js) ;
 *   2. applique les garde-fous : PR du même dépôt, branche claude/*, auteur avec droit
 *      d'écriture, émetteur de l'événement = Codex, label d'arrêt, interrupteur global ;
 *   3. réserve de façon ATOMIQUE et PERSISTANTE le SHA courant et un cycle de correction
 *      (au plus 1 tentative par SHA, 2 cycles par PR) sous forme de refs Git
 *      refs/codex-gate/v1/** ;
 *   4. journalise une décision structurée : WOULD_DISPATCH_CLAUDE, SKIP ou UNVERIFIED.
 *
 * Le composant de lecture (phase « analyze », permissions en lecture seule) est séparé
 * du composant d'écriture (phase « reserve », seule à disposer de contents: write) ; ce
 * dernier ne reçoit que des valeurs validées (n° de PR, SHA, sections) et revérifie
 * lui-même la PR, le SHA et les droits auprès de l'API. Aucun texte de commentaire n'est
 * transmis, affiché ou interprété.
 *
 * Usage (variable GATE_PHASE) :
 *   analyze     analyse d'un événement réel ou d'un lancement manuel (lecture seule)
 *   reserve     réservation persistante (GATE_PR_NUMBER, GATE_HEAD_SHA, GATE_SECTIONS)
 *   self-test   preuve d'atomicité du stockage sur GitHub (refs refs/codex-gate/v1/selftest/**)
 *   demo        démonstration hors ligne (aucun appel API), décisions positives et négatives
 * Documentation : docs/codex-feedback-gate.md
 */
'use strict';

const fs = require('node:fs');
const D = require('./detect.js');

const GATE = Object.freeze({
  DISPATCH: 'WOULD_DISPATCH_CLAUDE',
  SKIP: 'SKIP',
  UNVERIFIED: 'UNVERIFIED',
  ELIGIBLE: 'ELIGIBLE' // étape intermédiaire de l'analyse : en attente de réservation
});

const LIMITS = Object.freeze({ attemptsPerSha: 1, cyclesPerPr: D.MAX_FIX_CYCLES });
const STOP_LABEL = 'codex-gate:stop';
const REF_ROOT = 'refs/codex-gate/v1/';
const RECORD_HEADER = 'codex-gate-record:v1';
const MAX_RECORD_JSON = 2000;
const SECTIONS = ['code_review', 'security_review'];
const TRUSTED_PERMISSIONS = ['admin', 'write']; // « maintain » est renvoyé comme « write » par l'API
const SHA_RE = /^[0-9a-f]{40}$/;
const PR_RE = /^[1-9][0-9]{0,9}$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const BRANCH_RE = /^claude\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const KEY_RE = /^codex-fix:pr-[1-9][0-9]{0,9}:[0-9a-f]{40}:(code_review|security_review|code_review\+security_review)$/;
const GATE_REF_RE = new RegExp('^refs/codex-gate/v1/(?:pr-[1-9][0-9]{0,9}/(?:sha/[0-9a-f]{40}|cycle/[1-9])' +
  '|selftest/[0-9]{1,20}/[a-z0-9-]{1,32})$');

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Garde-fous (fonctions pures)
// ---------------------------------------------------------------------------

/** Branche source autorisée : claude/…, jamais la branche par défaut, aucun segment douteux. */
function isAllowedBranch(ref, defaultBranch) {
  return typeof ref === 'string' && ref.length <= 200 && BRANCH_RE.test(ref) &&
    !/(^|\/)\.|\.\.|\.lock(\/|$)|\/$/.test(ref) && ref !== defaultBranch;
}

function sameRepo(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/**
 * Vérifie la PR relue via l'API. Retourne null si elle est acceptable, sinon
 * { decision, reason }. `repo` vient de l'environnement GitHub Actions (GITHUB_REPOSITORY).
 */
function checkPullRequest(pr, repo) {
  if (!isObject(pr) || !isObject(pr.head) || !isObject(pr.base) || !isObject(pr.base.repo) ||
      typeof pr.head.sha !== 'string' || !SHA_RE.test(pr.head.sha)) {
    return { decision: GATE.UNVERIFIED, reason: 'PR_DATA_INCOMPLETE' };
  }
  if (pr.state !== 'open') return { decision: GATE.SKIP, reason: 'PR_NOT_OPEN' };
  // Fork supprimé : head.repo vaut null. Fork existant : fork=true ou autre nom.
  if (!isObject(pr.head.repo) || pr.head.repo.fork !== false || !sameRepo(pr.head.repo.full_name, repo)) {
    return { decision: GATE.SKIP, reason: 'HEAD_REPO_NOT_ALLOWED' };
  }
  if (!sameRepo(pr.base.repo.full_name, repo)) return { decision: GATE.SKIP, reason: 'BASE_REPO_MISMATCH' };
  const defaultBranch = pr.base.repo.default_branch;
  if (typeof defaultBranch !== 'string' || !defaultBranch) return { decision: GATE.UNVERIFIED, reason: 'PR_DATA_INCOMPLETE' };
  if (!isAllowedBranch(pr.head.ref, defaultBranch)) return { decision: GATE.SKIP, reason: 'BRANCH_NOT_ALLOWED' };
  if (!Array.isArray(pr.labels)) return { decision: GATE.UNVERIFIED, reason: 'PR_DATA_INCOMPLETE' };
  if (pr.labels.some((l) => isObject(l) && l.name === STOP_LABEL)) return { decision: GATE.SKIP, reason: 'STOPPED_BY_LABEL' };
  if (!isObject(pr.user) || pr.user.type !== 'User' || typeof pr.user.login !== 'string' || !LOGIN_RE.test(pr.user.login)) {
    return { decision: GATE.SKIP, reason: 'AUTHOR_NOT_TRUSTED' };
  }
  return null;
}

/** Droit de l'auteur de la PR (champ `permission` de l'API collaborators/{login}/permission). */
function checkPermission(permission) {
  if (permission === undefined) return { decision: GATE.UNVERIFIED, reason: 'PERMISSION_UNKNOWN' };
  if (!TRUSTED_PERMISSIONS.includes(permission)) return { decision: GATE.SKIP, reason: 'AUTHOR_NOT_TRUSTED' };
  return null;
}

function validSections(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const s = [...new Set(list)].sort();
  return s.every((x) => SECTIONS.includes(x)) ? s : null;
}

/**
 * Étape d'analyse (pure) : événement + détection + PR + droit → éligibilité.
 * @param input { eventName, payload, detection, pr, permission, repo, enabled }
 * Retourne { decision, reason, eligible, plan?, ... } ; decision vaut ELIGIBLE quand la
 * réservation peut être tentée.
 */
function evaluateEligibility(input) {
  const { eventName, payload, detection, pr, permission, repo, enabled } = input;
  const base = { stage: 'analyze', prNumber: detection && detection.prNumber || null, eligible: false };
  const out = (decision, reason, extra = {}) => ({ ...base, decision, reason, ...extra });

  if (eventName !== 'issue_comment' && eventName !== 'workflow_dispatch') return out(GATE.SKIP, 'UNSUPPORTED_EVENT');
  const manual = eventName === 'workflow_dispatch';
  // Un humain (même administrateur) qui édite le résumé Codex n'est pas Codex.
  if (!manual && !(isObject(payload) && D.isCodexUser(payload.sender))) return out(GATE.SKIP, 'SENDER_NOT_CODEX');

  if (!isObject(detection)) return out(GATE.UNVERIFIED, 'DETECTION_MISSING');
  const detected = { headSha: detection.headSha || null, detection: { decision: detection.decision, reason: detection.reason } };
  if (detection.decision === D.DECISION.UNVERIFIED) return out(GATE.UNVERIFIED, detection.reason, detected);
  if (detection.decision !== D.DECISION.FIX) return out(GATE.SKIP, detection.reason, detected);

  const prProblem = checkPullRequest(pr, repo);
  if (prProblem) return out(prProblem.decision, prProblem.reason, detected);
  if (pr.head.sha !== detection.headSha) return out(GATE.UNVERIFIED, 'API_DATA_INVALID', detected);
  const permProblem = checkPermission(permission);
  if (permProblem) return out(permProblem.decision, permProblem.reason, detected);

  const sections = validSections((detection.findings || []).map((f) => f.section));
  if (!sections) return out(GATE.UNVERIFIED, 'SECTIONS_INVALID', detected);
  const plan = {
    prNumber: detection.prNumber,
    headSha: detection.headSha,
    sections,
    idempotencyKey: D.idempotencyKey(detection.prNumber, detection.headSha, sections),
    findingUrls: (detection.findings || []).map((f) => f.url).filter(Boolean)
  };
  const extra = { ...detected, idempotencyKey: plan.idempotencyKey, plan };
  if (manual) return out(GATE.SKIP, 'MANUAL_EVALUATION_ONLY', { ...extra, wouldBeEligible: true });
  if (!enabled) return out(GATE.SKIP, 'GATE_DISABLED', { ...extra, wouldBeEligible: true });
  return out(GATE.ELIGIBLE, 'ELIGIBLE_PENDING_RESERVATION', { ...extra, eligible: true });
}

// ---------------------------------------------------------------------------
// Enregistrements de réservation (objets tag Git annotés)
// ---------------------------------------------------------------------------

function shaRef(pr, sha) { return `${REF_ROOT}pr-${pr}/sha/${sha}`; }
function cycleRef(pr, k) { return `${REF_ROOT}pr-${pr}/cycle/${k}`; }

/** Seules les refs de la passerelle peuvent être lues, créées ou supprimées. */
function assertGateRef(name) {
  if (typeof name !== 'string' || !GATE_REF_RE.test(name)) throw new Error('ref hors de l\'espace refs/codex-gate/v1');
  return name;
}

function serializeRecord(record) {
  return `${RECORD_HEADER}\n${JSON.stringify(record)}\n`;
}

/** Relit un enregistrement ; null si absent, illisible ou invalide (traité comme « réservé, inconnu »). */
function parseRecord(message) {
  if (typeof message !== 'string' || !message.startsWith(RECORD_HEADER + '\n')) return null;
  const json = message.slice(RECORD_HEADER.length + 1).trim();
  if (json.length > MAX_RECORD_JSON) return null;
  let r;
  try { r = JSON.parse(json); } catch (e) { return null; }
  if (!isObject(r) || r.v !== 1) return null;
  if (r.kind === 'selftest') return typeof r.runId === 'string' && /^[0-9]{1,20}$/.test(r.runId) ? r : null;
  if (r.kind !== 'reservation' || !Number.isSafeInteger(r.pr) || r.pr < 1 || typeof r.sha !== 'string' ||
      !SHA_RE.test(r.sha) || typeof r.key !== 'string' || !KEY_RE.test(r.key) || !validSections(r.sections)) return null;
  return r;
}

// ---------------------------------------------------------------------------
// Stockage : refs Git via l'API GitHub (création atomique « si absente »)
// ---------------------------------------------------------------------------

class GateApiError extends Error {
  constructor(status, message, rateLimited = false) {
    super(message);
    this.status = status;
    this.rateLimited = rateLimited;
  }
}

function isRateLimited(res) {
  const h = res.headers && typeof res.headers.get === 'function' ? res.headers : { get: () => null };
  return res.status === 429 || (res.status === 403 && (h.get('x-ratelimit-remaining') === '0' || h.get('retry-after') !== null));
}

/** Enveloppe fetch : un dépassement de quota d'API devient une erreur identifiable. */
function guardedFetch(fetchImpl) {
  return async (url, init) => {
    const res = await fetchImpl(url, init);
    if (isRateLimited(res)) throw new GateApiError(res.status, `quota d'API GitHub atteint (HTTP ${res.status})`, true);
    return res;
  };
}

async function apiRequest(ctx, method, pathname, body) {
  const res = await ctx.fetch(`${ctx.apiUrl}/repos/${ctx.repo}${pathname}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${ctx.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  let data = null;
  if (res.status !== 204) { try { data = await res.json(); } catch (e) { data = null; } }
  return { status: res.status, ok: res.ok, data };
}

/**
 * Stockage persistant fondé sur les refs Git du dépôt :
 * - createRecord : objet tag annoté (contenu JSON sans texte non fiable) pointant sur le commit ;
 * - createRef    : POST /git/refs, atomique côté GitHub (422 « Reference already exists ») ;
 * - getRef, readRecord, deleteRef (cette dernière utilisée uniquement par l'auto-test).
 */
class GitRefStore {
  constructor(ctx) { this.ctx = ctx; }

  async createRecord(record) {
    const target = record.kind === 'selftest' ? record.commitSha : record.sha;
    const r = await apiRequest(this.ctx, 'POST', '/git/tags', {
      tag: record.kind === 'selftest' ? `codex-gate-selftest-${record.runId}` : `codex-gate-pr-${record.pr}`,
      message: serializeRecord(record), object: target, type: 'commit'
    });
    if (r.status !== 201 || !isObject(r.data) || !SHA_RE.test(String(r.data.sha))) {
      throw new GateApiError(r.status, `création de l'enregistrement refusée (HTTP ${r.status})`);
    }
    return r.data.sha;
  }

  async createRef(name, target) {
    assertGateRef(name);
    const r = await apiRequest(this.ctx, 'POST', '/git/refs', { ref: name, sha: target });
    if (r.status === 201) return 'created';
    if (r.status === 422 && isObject(r.data) && /reference already exists/i.test(String(r.data.message))) return 'exists';
    throw new GateApiError(r.status, `création de ref refusée (HTTP ${r.status})`);
  }

  async getRef(name) {
    assertGateRef(name);
    const r = await apiRequest(this.ctx, 'GET', `/git/ref/${name.slice('refs/'.length)}`);
    if (r.status === 404) return null;
    if (!r.ok || !isObject(r.data) || r.data.ref !== name || !isObject(r.data.object) || !SHA_RE.test(String(r.data.object.sha))) {
      throw new GateApiError(r.status, `lecture de ref impossible (HTTP ${r.status})`);
    }
    return r.data.object.sha;
  }

  async readRecord(id) {
    if (!SHA_RE.test(String(id))) return null;
    const r = await apiRequest(this.ctx, 'GET', `/git/tags/${id}`);
    if (r.status === 404) return null;
    if (!r.ok || !isObject(r.data)) throw new GateApiError(r.status, `lecture d'enregistrement impossible (HTTP ${r.status})`);
    return parseRecord(r.data.message);
  }

  async deleteRef(name) {
    assertGateRef(name);
    const r = await apiRequest(this.ctx, 'DELETE', `/git/refs/${name.slice('refs/'.length)}`);
    if (r.status !== 204 && r.status !== 404 && r.status !== 422) throw new GateApiError(r.status, `suppression de ref impossible (HTTP ${r.status})`);
  }
}

/**
 * Stockage en mémoire aux mêmes sémantiques (tests et démonstration hors ligne).
 * La vérification « absente → créer » se fait sans point d'attente : atomique en JavaScript,
 * même quand des réservations concurrentes s'entrelacent (attente simulée avant chaque opération).
 * `faults(op, name, phase)` peut lever une erreur avant ou après l'opération (réseau simulé).
 */
class MemoryStore {
  constructor({ faults = null } = {}) {
    this.refs = new Map();
    this.objects = new Map();
    this.counter = 0;
    this.faults = faults;
  }

  async tick() { await new Promise((resolve) => setImmediate(resolve)); }

  fault(op, name, phase) {
    if (this.faults && this.faults(op, name, phase)) throw new GateApiError(0, `erreur réseau simulée (${op}, ${phase})`);
  }

  createRecordSync(record) {
    const id = (++this.counter).toString(16).padStart(40, '0');
    this.objects.set(id, serializeRecord(record));
    return id;
  }

  async createRecord(record) {
    await this.tick();
    this.fault('createRecord', null, 'before');
    return this.createRecordSync(record);
  }

  async createRef(name, target) {
    assertGateRef(name);
    await this.tick();
    this.fault('createRef', name, 'before');
    let status = 'exists';
    if (!this.refs.has(name)) { this.refs.set(name, target); status = 'created'; }
    this.fault('createRef', name, 'after'); // réponse perdue alors que l'écriture a eu lieu
    return status;
  }

  async getRef(name) {
    assertGateRef(name);
    await this.tick();
    this.fault('getRef', name, 'before');
    return this.refs.has(name) ? this.refs.get(name) : null;
  }

  async readRecord(id) {
    await this.tick();
    return this.objects.has(id) ? parseRecord(this.objects.get(id)) : null;
  }

  async deleteRef(name) {
    assertGateRef(name);
    await this.tick();
    this.refs.delete(name);
  }

  /** Pré-remplit l'état (réservations d'exécutions précédentes). */
  seed({ pr, sha, sections, cycle = null, runId = '1' }) {
    const s = validSections(sections);
    const id = this.createRecordSync({ v: 1, kind: 'reservation', key: D.idempotencyKey(pr, sha, s), pr, sha, sections: s,
      runId, runAttempt: '1', createdAt: '2026-11-09T00:00:00Z' });
    this.refs.set(shaRef(pr, sha), id);
    if (cycle) this.refs.set(cycleRef(pr, cycle), id);
    return id;
  }
}

/**
 * Création de ref tolérante aux réponses perdues : en cas d'erreur, la ref est relue ;
 * si elle désigne notre enregistrement (identifiant unique par exécution), la création a réussi.
 */
async function createRefSafe(store, name, target) {
  try {
    return await store.createRef(name, target);
  } catch (e) {
    if (e && e.rateLimited) throw e;
    let current;
    try { current = await store.getRef(name); } catch (e2) { throw e; }
    if (current === target) return 'created';
    if (current) return 'exists';
    throw e;
  }
}

function errorReason(e) {
  return e && e.rateLimited ? 'API_RATE_LIMITED' : 'API_ERROR';
}
function errorNote(e) {
  return e && Number.isInteger(e.status) && e.status > 0 ? `HTTP_${e.status}` : 'NETWORK_ERROR';
}

/**
 * Réservation persistante : 1 tentative par SHA, au plus LIMITS.cyclesPerPr cycles par PR.
 * 1. enregistrement (tag annoté) ; 2. verrou du SHA (création atomique) ; 3. premier
 *    emplacement de cycle libre (création atomique). Échec après le verrou → bloqué
 *    (RESERVATION_INCOMPLETE puis SHA_ALREADY_RESERVED), jamais de seconde tentative.
 */
async function reserve(store, plan, meta = {}) {
  const sections = validSections(plan.sections);
  const base = { stage: 'reserve', prNumber: plan.prNumber, headSha: plan.headSha, maxCycles: LIMITS.cyclesPerPr };
  const out = (decision, reason, extra = {}) => ({ ...base, decision, reason, ...extra });
  if (!Number.isSafeInteger(plan.prNumber) || plan.prNumber < 1 || !SHA_RE.test(String(plan.headSha)) || !sections) {
    return out(GATE.UNVERIFIED, 'INVALID_INPUT');
  }
  const key = D.idempotencyKey(plan.prNumber, plan.headSha, sections);
  base.idempotencyKey = key;
  const record = { v: 1, kind: 'reservation', key, pr: plan.prNumber, sha: plan.headSha, sections,
    runId: String(meta.runId || '0'), runAttempt: String(meta.runAttempt || '1'), createdAt: meta.now || new Date().toISOString() };

  let id;
  try { id = await store.createRecord(record); } catch (e) {
    return out(GATE.UNVERIFIED, errorReason(e), { notes: [errorNote(e), 'NOTHING_RESERVED'] });
  }

  let lock;
  try { lock = await createRefSafe(store, shaRef(plan.prNumber, plan.headSha), id); } catch (e) {
    return out(GATE.UNVERIFIED, errorReason(e), { notes: [errorNote(e), 'NOTHING_RESERVED'] });
  }
  if (lock === 'exists') {
    // Le SHA a déjà été réservé : jamais de seconde tentative. On qualifie seulement la raison.
    let existing = null; let target = null; let slots = null;
    try {
      target = await store.getRef(shaRef(plan.prNumber, plan.headSha));
      existing = target ? await store.readRecord(target) : null;
      slots = [];
      for (let k = 1; k <= LIMITS.cyclesPerPr; k++) slots.push(await store.getRef(cycleRef(plan.prNumber, k)));
    } catch (e) { existing = null; }
    if (!existing || existing.kind !== 'reservation' || existing.sha !== plan.headSha || existing.pr !== plan.prNumber) {
      return out(GATE.SKIP, 'SHA_ALREADY_RESERVED', { notes: ['RECORD_UNREADABLE'] });
    }
    const previous = { runId: existing.runId, sections: existing.sections };
    if (!slots.includes(target)) {
      // Verrou sans cycle : limite atteinte, ou échec entre les deux réservations (déblocage humain).
      return slots.every(Boolean)
        ? out(GATE.SKIP, 'CYCLE_LIMIT_REACHED', { previous, notes: ['SHA_LOCKED_AT_LIMIT'] })
        : out(GATE.SKIP, 'SHA_LOCKED_WITHOUT_CYCLE', { previous, notes: ['MANUAL_UNLOCK_REQUIRED'] });
    }
    if (existing.key === key) return out(GATE.SKIP, 'DUPLICATE_EVENT', { previous });
    return out(GATE.SKIP, 'NEW_FINDING_ON_ATTEMPTED_SHA', { previous });
  }

  for (let k = 1; k <= LIMITS.cyclesPerPr; k++) {
    let slot;
    try { slot = await createRefSafe(store, cycleRef(plan.prNumber, k), id); } catch (e) {
      return out(GATE.UNVERIFIED, 'RESERVATION_INCOMPLETE', { notes: [errorNote(e), 'SHA_LOCKED_NO_CYCLE'] });
    }
    if (slot === 'created') {
      return out(GATE.DISPATCH, 'RESERVED_NO_DISPATCH_IN_B1', {
        cycle: k, reservation: { shaRef: shaRef(plan.prNumber, plan.headSha), cycleRef: cycleRef(plan.prNumber, k), record: id }
      });
    }
  }
  return out(GATE.SKIP, 'CYCLE_LIMIT_REACHED', { notes: ['SHA_LOCKED_AT_LIMIT'] });
}

/**
 * Étape d'écriture : revérifie la PR et les droits via les chargeurs fournis,
 * puis réserve. Ne fait confiance à aucune donnée de l'étape d'analyse hormis
 * les valeurs validées (n° de PR, SHA, sections).
 */
async function reserveStage({ input, enabled, repo, loadPr, loadPermission, store, meta }) {
  const base = { stage: 'reserve', prNumber: null };
  const out = (decision, reason, extra = {}) => ({ ...base, decision, reason, ...extra });
  const prNumber = typeof input.prNumber === 'string' && PR_RE.test(input.prNumber) ? Number(input.prNumber) : input.prNumber;
  const sections = typeof input.sections === 'string' ? validSections(input.sections.split('+')) : validSections(input.sections);
  if (!Number.isSafeInteger(prNumber) || prNumber < 1 || typeof input.headSha !== 'string' || !SHA_RE.test(input.headSha) || !sections) {
    return out(GATE.UNVERIFIED, 'INVALID_INPUT');
  }
  base.prNumber = prNumber;
  base.headSha = input.headSha;
  if (!enabled) return out(GATE.SKIP, 'GATE_DISABLED');

  let pr; let permission;
  try {
    pr = await loadPr(prNumber);
    if (!isObject(pr) || pr.number !== prNumber) return out(GATE.UNVERIFIED, 'PR_DATA_INCOMPLETE');
    const prProblem = checkPullRequest(pr, repo);
    if (prProblem) return out(prProblem.decision, prProblem.reason);
    if (pr.head.sha !== input.headSha) return out(GATE.SKIP, 'STALE_SHA', { currentSha: pr.head.sha });
    permission = await loadPermission(pr.user.login);
  } catch (e) {
    return out(GATE.UNVERIFIED, errorReason(e), { notes: [errorNote(e)] });
  }
  const permProblem = checkPermission(permission);
  if (permProblem) return out(permProblem.decision, permProblem.reason);
  return reserve(store, { prNumber, headSha: input.headSha, sections }, meta);
}

/** Étape d'analyse avec chargeurs injectables (API réelle ou scénario). */
async function analyzeStage({ eventName, payload, enabled, repo, loadApi, loadPermission }) {
  const trigger = D.readTrigger(eventName, payload);
  const early = (decision, reason, prNumber = null) => ({ stage: 'analyze', prNumber, eligible: false, decision, reason });
  if (eventName !== 'issue_comment' && eventName !== 'workflow_dispatch') return early(GATE.SKIP, 'UNSUPPORTED_EVENT');
  if (trigger.stop) {
    return early(trigger.stop.decision === D.DECISION.UNVERIFIED ? GATE.UNVERIFIED : GATE.SKIP, trigger.stop.reason,
      trigger.stop.prNumber || null);
  }
  // Émetteur vérifié avant tout appel API.
  if (eventName === 'issue_comment' && !D.isCodexUser(payload.sender)) return early(GATE.SKIP, 'SENDER_NOT_CODEX', trigger.prNumber);

  let api; let detection; let result;
  try {
    api = await loadApi(trigger.prNumber);
    detection = D.analyze(trigger, api, { seenKeys: new Set() });
    const common = { eventName, payload, detection, pr: api && api.pr, repo, enabled };
    result = evaluateEligibility({ ...common, permission: undefined });
    if (result.reason === 'PERMISSION_UNKNOWN') {
      result = evaluateEligibility({ ...common, permission: await loadPermission(api.pr.user.login) });
    }
  } catch (e) {
    return { ...early(GATE.UNVERIFIED, errorReason(e), trigger.prNumber), notes: [errorNote(e)] };
  }
  if (detection && detection.findings) result.findingUrls = detection.findings.map((f) => f.url).filter(Boolean);
  return result;
}

/** Chaîne complète sur un scénario simulé (analyse puis réservation), sans réseau. */
async function simulate(sc, store = new MemoryStore()) {
  const repo = sc.repo || 'Anand-Helora/TestDoubleIA';
  const enabled = sc.enabled !== false;
  const permissionOf = async () => sc.permission;
  const analysis = await analyzeStage({ eventName: sc.eventName, payload: sc.payload, enabled, repo,
    loadApi: async () => { if (sc.apiError) throw sc.apiError; return sc.api; }, loadPermission: permissionOf });
  if (!analysis.eligible) return { analysis, final: analysis };
  const final = await reserveStage({
    input: { prNumber: String(analysis.plan.prNumber), headSha: analysis.plan.headSha, sections: analysis.plan.sections.join('+') },
    enabled, repo, store, meta: { runId: sc.runId || '100', runAttempt: '1', now: '2026-11-09T00:00:00Z' },
    loadPr: async () => (sc.prAtReserve || sc.api.pr), loadPermission: permissionOf
  });
  return { analysis, final };
}

/** Auto-test du stockage : création, doublon, course concurrente, relecture, nettoyage. */
async function storeSelfTest(store, { runId, commitSha, racers = 5 }) {
  const checks = [];
  const check = (name, ok) => checks.push({ name, ok: ok === true });
  const lock = `${REF_ROOT}selftest/${runId}/lock`;
  const race = `${REF_ROOT}selftest/${runId}/race`;
  const created = [];
  try {
    const rec = () => store.createRecord({ v: 1, kind: 'selftest', runId: String(runId), commitSha });
    const id = await rec();
    const first = await store.createRef(lock, id);
    if (first === 'created') created.push(lock);
    check('CREATE_IF_ABSENT', first === 'created');
    check('SECOND_CREATE_REJECTED', (await store.createRef(lock, await rec())) === 'exists');
    check('READ_BACK_TARGET', (await store.getRef(lock)) === id);
    const back = await store.readRecord(id);
    check('READ_BACK_RECORD', isObject(back) && back.kind === 'selftest' && back.runId === String(runId));

    const ids = await Promise.all(Array.from({ length: racers }, rec));
    const statuses = await Promise.all(ids.map((x) => store.createRef(race, x).catch(() => 'error')));
    if (statuses.includes('created')) created.push(race);
    check('CONCURRENT_SINGLE_WINNER', statuses.filter((s) => s === 'created').length === 1 &&
      statuses.filter((s) => s === 'exists').length === racers - 1);
    const winner = await store.getRef(race);
    check('WINNER_IS_ONE_OF_RACERS', ids.includes(winner) && ids[statuses.indexOf('created')] === winner);
  } catch (e) {
    check('NO_API_ERROR', false);
    checks.push({ name: errorNote(e), ok: false });
  } finally {
    for (const name of created) { try { await store.deleteRef(name); } catch (e) { /* signalé ci-dessous */ } }
  }
  try {
    check('CLEANUP', (await store.getRef(lock)) === null && (await store.getRef(race)) === null);
  } catch (e) { check('CLEANUP', false); }
  return { ok: checks.every((c) => c.ok), checks };
}

// ---------------------------------------------------------------------------
// Sortie : jamais de texte de commentaire, uniquement des valeurs validées
// ---------------------------------------------------------------------------

const clean = D.clean;

function renderSummary(r, title) {
  const lines = [
    `## ${title}`,
    '',
    '| Champ | Valeur |',
    '| --- | --- |',
    `| Étape | ${clean(r.stage || '—')} |`,
    `| Décision | **${clean(r.decision)}** |`,
    `| Raison | \`${clean(r.reason)}\` |`,
    `| PR | ${r.prNumber ? '#' + clean(r.prNumber) : '—'} |`,
    `| SHA courant | ${r.headSha ? '`' + clean(r.headSha) + '`' : '—'} |`
  ];
  if (r.detection) lines.push(`| Détection Codex | ${clean(r.detection.decision)} / \`${clean(r.detection.reason)}\` |`);
  if (r.idempotencyKey) lines.push(`| Clé d'idempotence | \`${clean(r.idempotencyKey)}\` |`);
  if (r.cycle) lines.push(`| Cycle réservé | ${clean(r.cycle)} / ${clean(r.maxCycles)} |`);
  if (r.wouldBeEligible) lines.push('| Éligible | oui (aucune réservation dans ce mode) |');
  if (r.notes && r.notes.length) lines.push(`| Notes | ${r.notes.map(clean).join(', ')} |`);
  if (r.findingUrls && r.findingUrls.length) {
    lines.push('', '### Remarques Codex', '', ...r.findingUrls.map((u, i) => `- [remarque ${i + 1}](${u})`));
  }
  lines.push('', '_Phase B1 : aucun appel à Claude ni à l\'API Anthropic, aucune correction, aucune fusion._', '');
  return lines.join('\n');
}

function publicResult(r) {
  // Le plan n'est pas réécrit dans le journal : ses valeurs utiles y figurent déjà.
  const { plan, ...rest } = r;
  return rest;
}

function emit(result, env, deps, title) {
  const out = deps.out || ((s) => process.stdout.write(s + '\n'));
  const write = deps.appendFile || fs.appendFileSync;
  out(`::notice title=${title}::${clean(result.stage)} — ${clean(result.decision)} — ${clean(result.reason)}` +
    (result.prNumber ? ` — PR #${clean(result.prNumber)}` : ''));
  out(JSON.stringify(publicResult(result)));
  if (env.GITHUB_STEP_SUMMARY) write(env.GITHUB_STEP_SUMMARY, renderSummary(result, title) + '\n');
  if (env.GITHUB_OUTPUT) {
    const p = result.plan;
    const lines = [`decision=${clean(result.decision)}`, `reason=${clean(result.reason)}`, `eligible=${result.eligible === true}`];
    if (result.eligible && p && Number.isSafeInteger(p.prNumber) && SHA_RE.test(p.headSha) && validSections(p.sections)) {
      lines.push(`pr_number=${p.prNumber}`, `head_sha=${p.headSha}`, `sections=${validSections(p.sections).join('+')}`);
    }
    write(env.GITHUB_OUTPUT, lines.join('\n') + '\n');
  }
}

// ---------------------------------------------------------------------------
// Exécution
// ---------------------------------------------------------------------------

function githubContext(env, deps) {
  if (!env.GITHUB_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY || '')) return null;
  return {
    repo: env.GITHUB_REPOSITORY,
    token: env.GITHUB_TOKEN,
    apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
    graphqlUrl: env.GITHUB_GRAPHQL_URL || 'https://api.github.com/graphql',
    fetch: guardedFetch(deps.fetch || globalThis.fetch)
  };
}

async function loadPermissionFrom(ctx, login) {
  if (typeof login !== 'string' || !LOGIN_RE.test(login)) return 'none';
  const r = await apiRequest(ctx, 'GET', `/collaborators/${login}/permission`);
  if (r.status === 404) return 'none';
  if (!r.ok || !isObject(r.data) || typeof r.data.permission !== 'string') {
    throw new GateApiError(r.status, `lecture des droits impossible (HTTP ${r.status})`);
  }
  return r.data.permission;
}

async function loadPrFrom(ctx, number) {
  const r = await apiRequest(ctx, 'GET', `/pulls/${number}`);
  if (!r.ok) throw new GateApiError(r.status, `lecture de la PR impossible (HTTP ${r.status})`);
  return r.data;
}

async function run(env, deps = {}) {
  const phase = env.GATE_PHASE;
  const enabled = env.CODEX_GATE_ENABLED === 'true';
  const title = 'Codex feedback gate (B1)';
  const meta = { runId: /^[0-9]{1,20}$/.test(env.GITHUB_RUN_ID || '') ? env.GITHUB_RUN_ID : '0',
    runAttempt: /^[0-9]{1,6}$/.test(env.GITHUB_RUN_ATTEMPT || '') ? env.GITHUB_RUN_ATTEMPT : '1' };
  let result;

  if (phase === 'demo') {
    const S = require('./gate-scenarios.js');
    const out = deps.out || ((s) => process.stdout.write(s + '\n'));
    const rows = [];
    let ok = true;
    for (const sc of S.scenarios()) {
      const store = new MemoryStore();
      for (const s of sc.seed || []) store.seed(s);
      const { final } = await simulate(sc, store);
      const pass = final.decision === sc.expected.decision && final.reason === sc.expected.reason;
      ok = ok && pass;
      rows.push(`| ${clean(sc.name)} | ${clean(final.decision)} | \`${clean(final.reason)}\` | ${pass ? 'oui' : '**NON**'} |`);
      out(`::notice title=${title} (démo)::${clean(sc.name)} — ${clean(final.decision)} — ${clean(final.reason)}`);
    }
    const md = ['## Codex feedback gate — démonstration hors ligne', '', '| Scénario | Décision | Raison | Conforme |',
      '| --- | --- | --- | --- |', ...rows, '', '_Stockage simulé en mémoire, aucun appel API, aucun appel à Claude._', ''].join('\n');
    if (env.GITHUB_STEP_SUMMARY) (deps.appendFile || fs.appendFileSync)(env.GITHUB_STEP_SUMMARY, md + '\n');
    if (!ok) { out(`::error title=${title} (démo)::résultat non conforme`); process.exitCode = 1; }
    return { ok, rows };
  }

  const ctx = githubContext(env, deps);

  if (phase === 'self-test') {
    if (!ctx || !SHA_RE.test(env.GITHUB_SHA || '')) {
      result = { stage: 'self-test', decision: GATE.UNVERIFIED, reason: 'MISSING_CONTEXT' };
    } else {
      const st = await storeSelfTest(deps.store || new GitRefStore(ctx), { runId: meta.runId, commitSha: env.GITHUB_SHA });
      result = { stage: 'self-test', decision: st.ok ? 'PASS' : 'FAIL', reason: st.ok ? 'STORE_ATOMIC_AND_DURABLE' : 'STORE_CHECK_FAILED',
        notes: st.checks.map((c) => `${c.name}:${c.ok ? 'ok' : 'KO'}`) };
      if (!st.ok) process.exitCode = 1;
    }
    emit(result, env, deps, title);
    return result;
  }

  if (phase === 'analyze') {
    const eventName = env.GITHUB_EVENT_NAME;
    let payload = null;
    try { payload = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')); } catch (e) { payload = null; }
    if (!ctx) {
      const pre = await analyzeStage({ eventName, payload, enabled, repo: '', loadApi: async () => { throw new Error('contexte'); },
        loadPermission: async () => undefined });
      result = pre.reason === 'API_ERROR' ? { ...pre, reason: 'MISSING_CONTEXT', notes: [] } : pre;
    } else {
      result = await analyzeStage({ eventName, payload, enabled, repo: ctx.repo,
        loadApi: (n) => D.fetchApiData(n, ctx), loadPermission: (login) => loadPermissionFrom(ctx, login) });
    }
  } else if (phase === 'reserve') {
    const input = { prNumber: env.GATE_PR_NUMBER, headSha: env.GATE_HEAD_SHA, sections: env.GATE_SECTIONS };
    if (!ctx) {
      result = { stage: 'reserve', prNumber: null, decision: GATE.UNVERIFIED, reason: 'MISSING_CONTEXT' };
    } else {
      result = await reserveStage({ input, enabled, repo: ctx.repo, meta: { ...meta, now: new Date().toISOString() },
        store: deps.store || new GitRefStore(ctx),
        loadPr: (n) => loadPrFrom(ctx, n), loadPermission: (login) => loadPermissionFrom(ctx, login) });
    }
  } else {
    result = { stage: 'none', decision: GATE.UNVERIFIED, reason: 'UNKNOWN_PHASE' };
  }
  emit(result, env, deps, title);
  return result;
}

module.exports = {
  GATE, LIMITS, STOP_LABEL, REF_ROOT,
  isAllowedBranch, checkPullRequest, checkPermission, evaluateEligibility,
  shaRef, cycleRef, assertGateRef, serializeRecord, parseRecord,
  GateApiError, isRateLimited, guardedFetch, GitRefStore, MemoryStore, createRefSafe,
  reserve, reserveStage, analyzeStage, simulate, storeSelfTest, renderSummary, run
};

if (require.main === module) {
  run({ ...process.env }).catch((e) => {
    process.stdout.write(`::error title=Codex feedback gate (B1)::erreur interne ${clean(e && e.message)}\n`);
    process.exitCode = 1;
  });
}
