// Tests de la passerelle expérimentale Codex → statut GitHub (Issue #17). Lancement : node --test
// Aucun appel réseau : l'API GitHub est simulée.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const B = require('../tools/codex-feedback/status-bridge.js');
const BS = require('../tools/codex-feedback/status-bridge-scenarios.js');
const S = require('../tools/codex-feedback/gate-scenarios.js');

const ROOT = path.join(__dirname, '..');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'codex-status-bridge.yml'), 'utf8');
const GATE_WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'codex-feedback-gate.yml'), 'utf8');
const { REPO, HEAD, NEW_HEAD } = S;
const MAIN_SHA = 'f'.repeat(40); // SHA de main porté par l'événement issue_comment (GITHUB_SHA)

const base = (o = {}) => ({ eventName: 'issue_comment', payload: S.summaryEvent(), api: S.findingApi(), permission: 'admin', ...o });

// --- Scénarios (aussi joués par le mode démo) --------------------------------

for (const sc of BS.scenarios()) {
  test(`scénario : ${sc.name}`, async () => {
    const statuses = new B.MemoryStatuses({ initial: sc.initialStatuses || {} });
    const { final } = await B.simulate(sc, statuses);
    assert.equal(final.decision, sc.expected.decision);
    assert.equal(final.reason, sc.expected.reason);
    assert.equal(statuses.writes.map((w) => w.state).join('+') || '—', sc.expected.writes || '—');
  });
}

// --- Décision ----------------------------------------------------------------

test('failure : contexte dédié, description statique, statut sur le SHA de tête', async () => {
  const st = new B.MemoryStatuses();
  const { final } = await B.simulate(base({ runId: '987' }), st);
  assert.equal(final.decision, 'PUBLISHED');
  assert.deepEqual(st.writes, [{ sha: HEAD, state: 'failure', context: 'codex/verified-review',
    description: B.DESCRIPTIONS.failure, target_url: `https://github.com/${REPO}/actions/runs/987` }]);
});

test('descriptions : constantes, ≤ 140 caractères, sans texte de commentaire', () => {
  for (const t of B.TARGETS) {
    assert.ok(B.DESCRIPTIONS[t].length <= 140);
    assert.doesNotMatch(B.DESCRIPTIONS[t], /curl|rm -rf|Ignore|@claude|\$\(/);
  }
  assert.throws(() => B.statusPayload('error'), /invalide/);
});

test('target_url : uniquement github.com/<dépôt>/actions/runs/<id> ou la PR', () => {
  assert.equal(B.targetUrl(REPO, '42', 7), `https://github.com/${REPO}/actions/runs/42`);
  assert.equal(B.targetUrl(REPO, null, 7), `https://github.com/${REPO}/pull/7`);
  assert.equal(B.targetUrl(REPO, '42/../../evil', 7), `https://github.com/${REPO}/pull/7`);
  assert.equal(B.targetUrl('evil.example/x?y', '42', 7), null);
  assert.equal(B.targetUrl('a/b"onmouseover', '42', 7), null);
});

test('revue partielle : pas de success si une section reste sur un ancien SHA', () => {
  assert.equal(B.summaryCompleteOnHead(S.cleanApi(), HEAD), true);
  assert.equal(B.summaryCompleteOnHead(BS.partialApi(), HEAD), false);
  assert.equal(B.summaryCompleteOnHead(S.cleanApi({ status: 'running', unresolved: null }), HEAD), false);
  const noSummary = S.cleanApi();
  noSummary.issueComments = [];
  assert.equal(B.summaryCompleteOnHead(noSummary, HEAD), false);
  // Avis Codex (review) sur le SHA mais aucun résumé terminé : jamais de success
  const reviewOnly = S.cleanApi();
  reviewOnly.issueComments = [];
  reviewOnly.reviews = [{ id: 801, user: S.CODEX_USER, commit_id: HEAD, state: 'COMMENTED', body: '' }];
  assert.deepEqual(B.decideTarget({ decision: 'NO_ACTION', reason: 'NO_FINDINGS_ON_HEAD', headSha: HEAD }, reviewOnly),
    { target: 'pending', reason: 'REVIEW_PARTIAL_ON_HEAD' });
});

test('résumé propre imité par un tiers : ignoré (seul le résumé Codex fait foi)', () => {
  const api = S.findingApi();
  api.issueComments.push({ ...S.summaryComment({ id: 999, unresolved: false, user: S.OUTSIDER }), updated_at: '2026-12-01T00:00:00Z' });
  assert.equal(B.summaryCompleteOnHead(api, HEAD), false);
});

test('decideTarget : correspondance complète des décisions du détecteur', () => {
  const t = (decision, reason) => B.decideTarget({ decision, reason, headSha: HEAD }, S.cleanApi()).target;
  assert.equal(t('WOULD_REQUEST_CLAUDE_FIX', 'CONFIRMED_UNRESOLVED_FINDINGS_ON_HEAD'), 'failure');
  assert.equal(t('NO_ACTION', 'NO_FINDINGS_ON_HEAD'), 'success');
  for (const r of B.SUSPEND_REASONS) assert.equal(t('UNVERIFIED', r), 'pending');
  for (const r of ['API_DATA_INVALID', 'API_ERROR', 'MALFORMED_PAYLOAD']) assert.equal(t('UNVERIFIED', r), null);
  for (const r of ['CYCLE_LIMIT_REACHED', 'REVIEW_ON_STALE_SHA', 'NO_CODEX_REVIEW', 'PR_NOT_OPEN', 'DUPLICATE_ALREADY_REPORTED']) {
    assert.equal(t('NO_ACTION', r), null);
  }
  assert.equal(B.decideTarget(null).target, null);
});

test('writeNeeded : idempotence, suspension seulement d\'un verdict existant, statut tiers remplacé', () => {
  const ours = (state) => ({ state, description: B.DESCRIPTIONS[state], ours: true });
  assert.deepEqual(B.writeNeeded('failure', ours('failure')), { write: false, reason: 'ALREADY_PUBLISHED' });
  assert.deepEqual(B.writeNeeded('success', ours('success')), { write: false, reason: 'ALREADY_PUBLISHED' });
  assert.deepEqual(B.writeNeeded('success', ours('failure')), { write: true });
  assert.deepEqual(B.writeNeeded('failure', ours('pending')), { write: true });
  assert.deepEqual(B.writeNeeded('failure', null), { write: true });
  assert.deepEqual(B.writeNeeded('failure', { state: 'failure', description: B.DESCRIPTIONS.failure, ours: false }),
    { write: true, note: 'FOREIGN_STATUS_REPLACED' });
  assert.equal(B.writeNeeded('pending', null).write, false);
  assert.equal(B.writeNeeded('pending', ours('pending')).write, false);
  assert.equal(B.writeNeeded('pending', ours('failure')).write, true);
});

// --- Doublons, boucles, concurrence --------------------------------------------

test('résumé créé, édité puis rejoué : un seul failure publié', async () => {
  const st = new B.MemoryStatuses();
  const reasons = [];
  for (const action of ['created', 'edited', 'edited']) {
    reasons.push((await B.simulate(base({ payload: S.summaryEvent({ action }) }), st)).final.reason);
  }
  assert.deepEqual(reasons, ['STATUS_FAILURE_PUBLISHED', 'ALREADY_PUBLISHED', 'ALREADY_PUBLISHED']);
  assert.equal(st.writes.length, 1);
});

test('cycle réaliste : failure → correction (nouveau SHA) → revue propre → success sur le nouveau SHA', async () => {
  const st = new B.MemoryStatuses();
  const r1 = (await B.simulate(base(), st)).final;
  const r2 = (await B.simulate(base({ api: S.cleanApi({ sha: NEW_HEAD }) }), st)).final;
  assert.equal(r1.reason, 'STATUS_FAILURE_PUBLISHED');
  assert.equal(r2.reason, 'STATUS_SUCCESS_PUBLISHED');
  assert.deepEqual(st.writes.map((w) => [w.sha, w.state]), [[HEAD, 'failure'], [NEW_HEAD, 'success']]);
});

test('boucle bornée : au 3e SHA avec remarques, aucun failure (limite de cycles du détecteur)', async () => {
  const st = new B.MemoryStatuses();
  const { final } = await B.simulate(base({ api: BS.cycleLimitApi() }), st);
  assert.equal(final.reason, 'CYCLE_LIMIT_REACHED');
  assert.equal(st.writes.length, 0);
});

test('ancien verdict n\'écrase pas un état plus récent (réévaluation avant écriture)', async () => {
  // Analyse : failure ; entre-temps la revue est devenue propre et success a été publié.
  const st = new B.MemoryStatuses({ initial: { [HEAD]: [BS.prior('success')] } });
  const { final } = await B.simulate(base({ apiAtPublish: S.cleanApi() }), st);
  assert.equal(final.reason, 'VERDICT_CHANGED');
  assert.equal(st.writes.length, 0);
});

// --- Garde-fous et erreurs -------------------------------------------------------

test('faux bot : même login mais identifiant ou type différent → aucune analyse', async () => {
  const fake = { login: 'chatgpt-codex-connector[bot]', id: 1, type: 'Bot' };
  const st = new B.MemoryStatuses();
  const { final } = await B.simulate(base({ payload: S.summaryEvent({ sender: fake, comment: S.summaryComment({ user: fake }) }) }), st);
  assert.equal(final.reason, 'TRIGGER_NOT_FROM_CODEX');
  const r2 = await B.simulate(base({ payload: S.summaryEvent({ sender: { ...S.CODEX_USER, type: 'User' } }) }), st);
  assert.equal(r2.final.reason, 'SENDER_NOT_CODEX');
  assert.equal(st.writes.length, 0);
});

test('fork supprimé (head.repo nul) et base d\'un autre dépôt : refusés', async () => {
  const st = new B.MemoryStatuses();
  assert.equal((await B.simulate(base({ api: S.findingApi({ headRepo: null }) }), st)).final.reason, 'HEAD_REPO_NOT_ALLOWED');
  assert.equal((await B.simulate(base({ repo: 'autre/depot' }), st)).final.reason, 'HEAD_REPO_NOT_ALLOWED');
  assert.equal(st.writes.length, 0);
});

test('PR fermée entre l\'analyse et l\'écriture : aucune écriture', async () => {
  const st = new B.MemoryStatuses();
  const { final } = await B.simulate(base({ prAtWrite: S.pullRequest({ state: 'closed' }) }), st);
  assert.equal(final.reason, 'PR_NOT_OPEN');
  assert.equal(st.writes.length, 0);
});

test('SHA changé lors de la relecture complète : STALE_SHA', async () => {
  const st = new B.MemoryStatuses();
  const { final } = await B.simulate(base({ apiAtPublish: S.findingApi({ sha: NEW_HEAD }) }), st);
  assert.equal(final.reason, 'STALE_SHA');
  assert.equal(final.currentSha, NEW_HEAD);
  assert.equal(st.writes.length, 0);
});

test('erreurs API / quota : UNVERIFIED, rien n\'est publié', async () => {
  const limited = new Error('quota');
  limited.rateLimited = true; limited.status = 429;
  let r = await B.simulate(base({ apiError: limited }));
  assert.deepEqual([r.final.decision, r.final.reason], ['UNVERIFIED', 'API_RATE_LIMITED']);
  r = await B.simulate(base({ publishApiError: Object.assign(new Error('x'), { status: 502 }) }));
  assert.deepEqual([r.final.decision, r.final.reason, r.final.notes], ['UNVERIFIED', 'API_ERROR', ['HTTP_502', 'NOTHING_PUBLISHED']]);
  assert.equal(r.statuses.writes.length, 0);
  const st = new B.MemoryStatuses({ fail: (op) => (op === 'latest' ? Object.assign(new Error('y'), { status: 500 }) : null) });
  r = await B.simulate(base(), st);
  assert.equal(r.final.reason, 'API_ERROR');
  assert.equal(st.writes.length, 0);
});

test('entrées de publication invalides ou injectées : refusées sans appel API', async () => {
  let called = false;
  const loadApi = async () => { called = true; return S.findingApi(); };
  const st = new B.MemoryStatuses();
  const bad = [
    { prNumber: '7; rm -rf /', headSha: HEAD, target: 'failure' },
    { prNumber: '7', headSha: 'HEAD', target: 'failure' },
    { prNumber: '7', headSha: HEAD, target: 'error' },
    { prNumber: '7', headSha: HEAD, target: 'failure\ndescription=pwned' },
    { prNumber: 7, headSha: HEAD, target: 'failure' }
  ];
  for (const input of bad) {
    const r = await B.publishStage({ input, enabled: true, repo: REPO, loadApi, loadPermission: async () => 'admin',
      loadPr: async () => S.pullRequest(), statuses: st });
    assert.equal(r.reason, 'INVALID_INPUT');
  }
  assert.equal(called, false);
  assert.equal(st.writes.length, 0);
});

test('interrupteur : seule la valeur exacte « true » autorise la publication', async () => {
  for (const value of [undefined, '', 'false', 'TRUE', 'True', ' true', '1', 'yes']) {
    const st = new B.MemoryStatuses();
    const r = await B.publishStage({ input: { prNumber: '7', headSha: HEAD, target: 'failure' },
      enabled: value === 'true', repo: REPO, loadApi: async () => S.findingApi(), loadPermission: async () => 'admin',
      loadPr: async () => S.pullRequest(), statuses: st });
    assert.equal(r.reason, 'BRIDGE_DISABLED');
    assert.equal(st.writes.length, 0);
  }
});

test('lancement manuel : verdict affiché, jamais publié', async () => {
  const st = new B.MemoryStatuses();
  const { final } = await B.simulate(base({ eventName: 'workflow_dispatch', payload: { inputs: { pr_number: '7' } } }), st);
  assert.equal(final.reason, 'MANUAL_EVALUATION_ONLY');
  assert.equal(final.wouldPublish, 'failure');
  assert.equal(st.writes.length, 0);
});

// --- Exécution complète contre un faux GitHub --------------------------------------

function response(status, data, headers = {}) {
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: (k) => (Object.prototype.hasOwnProperty.call(headers, k.toLowerCase()) ? headers[k.toLowerCase()] : null) },
    json: async () => (data === undefined ? null : JSON.parse(JSON.stringify(data)))
  };
}

function fakeGitHub({ api = S.findingApi(), permission = 'admin', statuses = {}, hook = null } = {}) {
  const calls = [];
  const prefix = `https://api.test/repos/${REPO}`;
  async function fetch(url, init = {}) {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, url, body, auth: init.headers && init.headers.Authorization });
    if (hook) { const h = hook(method, url, body); if (h) return h; }
    if (url === 'https://api.test/graphql') {
      const nodes = Object.entries(api.threads || {}).map(([id, t]) => ({ ...t, comments: { nodes: [{ fullDatabaseId: id }] } }));
      return response(200, { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes } } } } });
    }
    const p = url.startsWith(prefix) ? url.slice(prefix.length).replace(/\?.*$/, '') : null;
    if (p === null) return response(404, {});
    if (method === 'GET' && p === '/pulls/7') return response(200, api.pr);
    if (method === 'GET' && p === '/issues/7/comments') return response(200, api.issueComments);
    if (method === 'GET' && p === '/pulls/7/reviews') return response(200, api.reviews);
    if (method === 'GET' && p === '/pulls/7/comments') return response(200, api.reviewComments);
    if (method === 'GET' && /^\/collaborators\/[^/]+\/permission$/.test(p)) return response(200, { permission });
    let m = /^\/commits\/([0-9a-f]{40})\/statuses$/.exec(p);
    if (method === 'GET' && m) return response(200, [...(statuses[m[1]] || [])].reverse());
    m = /^\/statuses\/([0-9a-f]{40})$/.exec(p);
    if (method === 'POST' && m) {
      (statuses[m[1]] = statuses[m[1]] || []).push({ ...body, creator: B.ACTIONS_BOT });
      return response(201, { id: 1, ...body });
    }
    return response(404, { message: 'Not Found' });
  }
  return { fetch, calls, statuses };
}

function runEnv(phase, extra = {}, payload = S.summaryEvent(), eventName = 'issue_comment') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-'));
  const eventPath = path.join(dir, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify(payload));
  const files = { summary: path.join(dir, 'summary.md'), output: path.join(dir, 'output.txt') };
  return {
    dir, files,
    env: {
      BRIDGE_PHASE: phase, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath, GITHUB_TOKEN: 'jeton-factice-secret',
      GITHUB_REPOSITORY: REPO, GITHUB_API_URL: 'https://api.test', GITHUB_GRAPHQL_URL: 'https://api.test/graphql',
      GITHUB_STEP_SUMMARY: files.summary, GITHUB_OUTPUT: files.output, GITHUB_RUN_ID: '555', GITHUB_SHA: MAIN_SHA,
      CODEX_STATUS_BRIDGE_ENABLED: 'true', ...extra
    }
  };
}
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
const writesOf = (calls) => calls.filter((c) => c.method !== 'GET' && !(c.method === 'POST' && c.url.endsWith('/graphql')));

test('bout en bout : analyse (lecture seule) puis publication sur le SHA de la PR, jamais celui de main', async () => {
  const gh = fakeGitHub();
  const a = runEnv('analyze');
  const analysis = await B.run(a.env, { fetch: gh.fetch, out: () => {} });
  assert.equal(analysis.eligible, true);
  assert.equal(writesOf(gh.calls).length, 0, 'aucune écriture pendant l\'analyse');
  const outputs = read(a.files.output);
  assert.match(outputs, new RegExp(`^head_sha=${HEAD}$`, 'm'));
  assert.match(outputs, /^target=failure$/m);

  const p = runEnv('publish', { BRIDGE_PR_NUMBER: '7', BRIDGE_HEAD_SHA: HEAD, BRIDGE_TARGET: 'failure' });
  const r = await B.run(p.env, { fetch: gh.fetch, out: () => {} });
  assert.equal(r.decision, 'PUBLISHED');
  const writes = writesOf(gh.calls);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].url, `https://api.test/repos/${REPO}/statuses/${HEAD}`);
  assert.ok(!writes[0].url.includes(MAIN_SHA));
  assert.deepEqual(writes[0].body, { state: 'failure', context: 'codex/verified-review',
    description: B.DESCRIPTIONS.failure, target_url: `https://github.com/${REPO}/actions/runs/555` });
  assert.ok(!gh.calls.some((c) => /\/git\//.test(c.url)), 'aucune réservation B1 ni ref créée');
  // Relance identique : aucun doublon
  const again = await B.run(p.env, { fetch: gh.fetch, out: () => {} });
  assert.equal(again.reason, 'ALREADY_PUBLISHED');
  assert.equal(writesOf(gh.calls).length, 1);
  fs.rmSync(a.dir, { recursive: true }); fs.rmSync(p.dir, { recursive: true });
});

test('bout en bout : interrupteur absent → aucune écriture, même en phase publish', async () => {
  const gh = fakeGitHub();
  for (const phase of ['analyze', 'publish']) {
    const { env, dir } = runEnv(phase, { CODEX_STATUS_BRIDGE_ENABLED: undefined, BRIDGE_PR_NUMBER: '7', BRIDGE_HEAD_SHA: HEAD, BRIDGE_TARGET: 'failure' });
    delete env.CODEX_STATUS_BRIDGE_ENABLED;
    const r = await B.run(env, { fetch: gh.fetch, out: () => {} });
    assert.equal(r.reason, 'BRIDGE_DISABLED');
    fs.rmSync(dir, { recursive: true });
  }
  assert.equal(writesOf(gh.calls).length, 0);
});

test('bout en bout : CODEX_GATE_ENABLED n\'active pas la passerelle de statut', async () => {
  const gh = fakeGitHub();
  const { env, dir } = runEnv('publish', { CODEX_STATUS_BRIDGE_ENABLED: '', CODEX_GATE_ENABLED: 'true',
    BRIDGE_PR_NUMBER: '7', BRIDGE_HEAD_SHA: HEAD, BRIDGE_TARGET: 'failure' });
  const r = await B.run(env, { fetch: gh.fetch, out: () => {} });
  assert.equal(r.reason, 'BRIDGE_DISABLED');
  assert.equal(writesOf(gh.calls).length, 0);
  fs.rmSync(dir, { recursive: true });
});

test('bout en bout : quota GitHub atteint → UNVERIFIED API_RATE_LIMITED, aucune écriture', async () => {
  const gh = fakeGitHub({ hook: (m, url) => (/\/commits\//.test(url) ? response(403, {}, { 'x-ratelimit-remaining': '0' }) : null) });
  const { env, dir } = runEnv('publish', { BRIDGE_PR_NUMBER: '7', BRIDGE_HEAD_SHA: HEAD, BRIDGE_TARGET: 'failure' });
  const r = await B.run(env, { fetch: gh.fetch, out: () => {} });
  assert.deepEqual([r.decision, r.reason], ['UNVERIFIED', 'API_RATE_LIMITED']);
  assert.equal(writesOf(gh.calls).length, 0);
  fs.rmSync(dir, { recursive: true });
});

test('bout en bout : POST refusé → UNVERIFIED (aucun faux « publié »)', async () => {
  const gh = fakeGitHub({ hook: (m, url) => (m === 'POST' && /\/statuses\//.test(url) ? response(403, { message: 'Resource not accessible' }) : null) });
  const { env, dir } = runEnv('publish', { BRIDGE_PR_NUMBER: '7', BRIDGE_HEAD_SHA: HEAD, BRIDGE_TARGET: 'failure' });
  const r = await B.run(env, { fetch: gh.fetch, out: () => {} });
  assert.deepEqual([r.decision, r.reason, r.notes], ['UNVERIFIED', 'API_ERROR', ['HTTP_403', 'NOTHING_PUBLISHED']]);
  fs.rmSync(dir, { recursive: true });
});

test('bout en bout : restauration success après une nouvelle revue propre du même SHA', async () => {
  const gh = fakeGitHub({ api: S.cleanApi(), statuses: { [HEAD]: [{ state: 'failure', context: B.CONTEXT, description: B.DESCRIPTIONS.failure, creator: B.ACTIONS_BOT }] } });
  const { env, dir } = runEnv('publish', { BRIDGE_PR_NUMBER: '7', BRIDGE_HEAD_SHA: HEAD, BRIDGE_TARGET: 'success' });
  const r = await B.run(env, { fetch: gh.fetch, out: () => {} });
  assert.deepEqual([r.decision, r.reason, r.previous], ['PUBLISHED', 'STATUS_SUCCESS_PUBLISHED', 'failure']);
  assert.equal(gh.statuses[HEAD].slice(-1)[0].state, 'success');
  fs.rmSync(dir, { recursive: true });
});

test('commentaires injectés : jamais dans le journal, le récapitulatif, les sorties ni le statut ; jeton jamais affiché', async () => {
  const gh = fakeGitHub();
  const lines = [];
  const a = runEnv('analyze');
  await B.run(a.env, { fetch: gh.fetch, out: (s) => lines.push(s) });
  const p = runEnv('publish', { BRIDGE_PR_NUMBER: '7', BRIDGE_HEAD_SHA: HEAD, BRIDGE_TARGET: 'failure' });
  await B.run(p.env, { fetch: gh.fetch, out: (s) => lines.push(s) });
  const all = [lines.join('\n'), read(a.files.summary), read(a.files.output), read(p.files.summary), read(p.files.output),
    JSON.stringify(writesOf(gh.calls).map((c) => c.body))].join('\n');
  assert.doesNotMatch(all, /curl|rm -rf|evil|Ignore previous|@claude|merge to main/i);
  assert.doesNotMatch(all, /jeton-factice-secret/);
  assert.ok(gh.calls.every((c) => c.auth === 'Bearer jeton-factice-secret'));
  fs.rmSync(a.dir, { recursive: true }); fs.rmSync(p.dir, { recursive: true });
});

test('sorties de step : seulement des valeurs validées, aucune sortie si non éligible', async () => {
  const gh = fakeGitHub({ api: S.findingApi({ ref: 'feature/x' }) });
  const { env, dir, files } = runEnv('analyze');
  const r = await B.run(env, { fetch: gh.fetch, out: () => {} });
  assert.equal(r.reason, 'BRANCH_NOT_ALLOWED');
  assert.doesNotMatch(read(files.output), /pr_number|head_sha|target/);
  fs.rmSync(dir, { recursive: true });
});

test('mode démo : tous les scénarios conformes, sans réseau', async () => {
  const { env, dir } = runEnv('demo');
  const r = await B.run(env, { fetch: () => { throw new Error('aucun réseau attendu'); }, out: () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, BS.scenarios().length);
  fs.rmSync(dir, { recursive: true });
});

test('phase inconnue ou contexte manquant : UNVERIFIED sans écriture', async () => {
  assert.equal((await B.run({ BRIDGE_PHASE: 'x' }, { out: () => {} })).reason, 'UNKNOWN_PHASE');
  assert.equal((await B.run({ BRIDGE_PHASE: 'publish', CODEX_STATUS_BRIDGE_ENABLED: 'true' }, { out: () => {} })).reason, 'MISSING_CONTEXT');
});

// --- Workflow : propriétés de sécurité vérifiées statiquement ----------------------

test('workflow : déclencheurs limités, aucune permission par défaut, seule écriture statuses', () => {
  const on = WORKFLOW.split('\non:\n')[1].split('\npermissions:')[0];
  assert.deepEqual([...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]), ['issue_comment', 'workflow_dispatch']);
  assert.match(WORKFLOW, /^permissions: \{\}$/m);
  const writes = [...WORKFLOW.matchAll(/^\s+([a-z-]+): write\b/gm)].map((m) => m[1]);
  assert.deepEqual(writes, ['statuses']);
  assert.doesNotMatch(WORKFLOW, /contents: write|issues: write|pull-requests: write|actions: write|checks: write/);
  assert.doesNotMatch(WORKFLOW, /write-all|read-all|pull_request_target|pull_request_review|workflow_run/);
  assert.doesNotMatch(WORKFLOW, /secrets\./);
  assert.doesNotMatch(WORKFLOW, /ANTHROPIC|CLAUDE_CODE_OAUTH|claude-code-action|oauth|allowed_bots/i);
  assert.doesNotMatch(WORKFLOW, /auto-merge|gh pr merge|enable_pr_auto_merge/i);
});

test('workflow : publication conditionnée à l\'interrupteur dédié, code de la branche par défaut', () => {
  const jobs = WORKFLOW.split('\njobs:\n')[1];
  const analyze = jobs.split('\n  publish:\n')[0];
  const publish = jobs.split('\n  publish:\n')[1];
  assert.doesNotMatch(analyze, /: write\b/);
  assert.match(publish, /needs: analyze/);
  assert.match(publish, /github\.event_name == 'issue_comment'/);
  assert.match(publish, /needs\.analyze\.outputs\.eligible == 'true'/);
  assert.match(publish, /vars\.CODEX_STATUS_BRIDGE_ENABLED == 'true'/);
  assert.doesNotMatch(WORKFLOW, /CODEX_GATE_ENABLED/);
  assert.match(publish, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(publish, /cancel-in-progress: false/);
  assert.equal((WORKFLOW.match(/persist-credentials: false/g) || []).length, 2);
  assert.equal((WORKFLOW.match(/'chatgpt-codex-connector\[bot\]'/g) || []).length, 2, 'auteur ET émetteur filtrés');
});

test('workflow : aucune expression ${{ }} dans les commandes, contenu des commentaires jamais lu', () => {
  const runLines = WORKFLOW.split('\n').filter((l) => /^\s*run:/.test(l)).map((l) => l.trim());
  assert.equal(runLines.length, 2);
  for (const l of runLines) assert.equal(l, 'run: node tools/codex-feedback/status-bridge.js');
  assert.doesNotMatch(WORKFLOW, /github\.event\.(comment|review|issue|pull_request)\.(body|title|head\.ref)/);
  const block = WORKFLOW.split('options:')[1].split('pr_number:')[0];
  assert.deepEqual([...block.matchAll(/^\s+- ([a-z-]+)\s*$/gm)].map((m) => m[1]), ['demo', 'evaluate-pr']);
});

test('passerelle B1 inchangée : toujours désactivée par son propre interrupteur', () => {
  assert.match(GATE_WORKFLOW, /vars\.CODEX_GATE_ENABLED == 'true'/);
  assert.doesNotMatch(GATE_WORKFLOW, /statuses: write/);
});

test('le module ne crée aucune ref, aucun fichier, aucune branche (aucune route d\'écriture hors /statuses)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'codex-feedback', 'status-bridge.js'), 'utf8');
  assert.doesNotMatch(src, /\/git\/|\/contents\/|\/merges|\/merge\b|\/labels|\/comments'/);
  assert.equal((src.match(/'POST'/g) || []).length, 1);
  assert.doesNotMatch(src, /'(PUT|PATCH|DELETE)'/);
  assert.doesNotMatch(src, /child_process|exec\(|spawn\(/);
});
