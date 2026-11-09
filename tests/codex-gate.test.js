// Tests de la passerelle Codex → Claude (Issue #9, phase B1). Lancement : node --test
// Aucun appel réseau : l'API GitHub est simulée (y compris la création atomique des refs).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const G = require('../tools/codex-feedback/gate.js');
const S = require('../tools/codex-feedback/gate-scenarios.js');

const ROOT = path.join(__dirname, '..');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'codex-feedback-gate.yml'), 'utf8');
const { REPO, HEAD, NEW_HEAD } = S;
const SHA_D = 'd'.repeat(40);
const SHA_E = 'e'.repeat(40);

const base = (o = {}) => ({ eventName: 'issue_comment', payload: S.summaryEvent(), api: S.findingApi(), permission: 'admin', ...o });
const withSeed = (seeds = [], opts) => { const s = new G.MemoryStore(opts); for (const x of seeds) s.seed(x); return s; };

// --- Simulation de l'API GitHub ----------------------------------------------

function response(status, data, headers = {}) {
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: (k) => (Object.prototype.hasOwnProperty.call(headers, k.toLowerCase()) ? headers[k.toLowerCase()] : null) },
    json: async () => (data === undefined ? null : JSON.parse(JSON.stringify(data)))
  };
}

/**
 * Faux GitHub : lecture de la PR, commentaires, fils GraphQL, droits, et stockage Git
 * (tags annotés, refs avec création atomique). L'état `git` peut être partagé entre
 * plusieurs « exécutions » pour prouver la persistance.
 */
function fakeGitHub({ api = S.findingApi(), permission = 'admin', git = { refs: new Map(), tags: new Map(), n: 0 }, hook = null } = {}) {
  const calls = [];
  const prefix = `https://api.test/repos/${REPO}`;
  async function fetch(url, init = {}) {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, url, body });
    await new Promise((r) => setImmediate(r));
    if (hook) { const h = hook(method, url, body); if (h) return h; }
    if (url === 'https://api.test/graphql') {
      const nodes = Object.entries(api.threads || {}).map(([id, t]) => ({ ...t, comments: { nodes: [{ fullDatabaseId: id }] } }));
      return response(200, { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes } } } } });
    }
    const p = url.startsWith(prefix) ? url.slice(prefix.length).replace(/\?.*$/, '') : null;
    if (p === null) return response(404, { message: 'Not Found' });
    if (method === 'GET' && p === '/pulls/7') return response(200, api.pr);
    if (method === 'GET' && p === '/issues/7/comments') return response(200, api.issueComments);
    if (method === 'GET' && p === '/pulls/7/reviews') return response(200, api.reviews);
    if (method === 'GET' && p === '/pulls/7/comments') return response(200, api.reviewComments);
    let m = /^\/collaborators\/([^/]+)\/permission$/.exec(p);
    if (method === 'GET' && m) return permission === null ? response(404, {}) : response(200, { permission, role_name: permission });
    if (method === 'POST' && p === '/git/tags') {
      const sha = (++git.n).toString(16).padStart(40, '0');
      git.tags.set(sha, { sha, message: body.message, object: { sha: body.object, type: body.type } });
      return response(201, { sha });
    }
    if (method === 'POST' && p === '/git/refs') {
      if (git.refs.has(body.ref)) return response(422, { message: 'Reference already exists' });
      git.refs.set(body.ref, body.sha);
      return response(201, { ref: body.ref, object: { sha: body.sha } });
    }
    m = /^\/git\/ref\/(.+)$/.exec(p);
    if (method === 'GET' && m) {
      const ref = `refs/${m[1]}`;
      return git.refs.has(ref) ? response(200, { ref, object: { sha: git.refs.get(ref), type: 'tag' } }) : response(404, { message: 'Not Found' });
    }
    m = /^\/git\/tags\/([0-9a-f]{40})$/.exec(p);
    if (method === 'GET' && m) return git.tags.has(m[1]) ? response(200, git.tags.get(m[1])) : response(404, {});
    m = /^\/git\/refs\/(.+)$/.exec(p);
    if (method === 'DELETE' && m) {
      const ref = `refs/${m[1]}`;
      if (!git.refs.has(ref)) return response(422, { message: 'Reference does not exist' });
      git.refs.delete(ref);
      return response(204);
    }
    return response(404, { message: 'Not Found' });
  }
  fetch.calls = calls;
  return { fetch, git, calls };
}

function ctxFor(fake) {
  return { repo: REPO, token: 'jeton-factice', apiUrl: 'https://api.test', graphqlUrl: 'https://api.test/graphql', fetch: G.guardedFetch(fake.fetch) };
}

function runEnv(phase, extra = {}, payload = S.summaryEvent(), eventName = 'issue_comment') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gate-'));
  const eventPath = path.join(dir, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify(payload));
  const files = { summary: path.join(dir, 'summary.md'), output: path.join(dir, 'output.txt') };
  return {
    dir, files,
    env: {
      GATE_PHASE: phase, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath, GITHUB_TOKEN: 'jeton-factice',
      GITHUB_REPOSITORY: REPO, GITHUB_API_URL: 'https://api.test', GITHUB_GRAPHQL_URL: 'https://api.test/graphql',
      GITHUB_STEP_SUMMARY: files.summary, GITHUB_OUTPUT: files.output, GITHUB_RUN_ID: '555', GITHUB_RUN_ATTEMPT: '1',
      CODEX_GATE_ENABLED: 'true', ...extra
    }
  };
}
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');

// --- Démonstration : décisions positives et négatives ------------------------

for (const sc of S.scenarios()) {
  test(`scénario : ${sc.name}`, async () => {
    const { final } = await G.simulate(sc, withSeed(sc.seed));
    assert.equal(final.decision, sc.expected.decision);
    assert.equal(final.reason, sc.expected.reason);
  });
}

test('mode démo : tous les scénarios conformes, récapitulatif sans texte de commentaire', async () => {
  const lines = [];
  const { dir, env, files } = runEnv('demo');
  const r = await G.run(env, { out: (s) => lines.push(s) });
  assert.equal(r.ok, true);
  const all = lines.join('\n') + read(files.summary);
  assert.match(all, /WOULD_DISPATCH_CLAUDE/);
  assert.match(all, /SKIP/);
  assert.doesNotMatch(all, /curl|rm -rf|evil|Ignore previous/i);
  fs.rmSync(dir, { recursive: true });
});

// --- Déduplication persistante et limites -----------------------------------

test('décision positive : réservation du SHA et du cycle 1, sans aucun appel à Claude', async () => {
  const store = new G.MemoryStore();
  const { analysis, final } = await G.simulate(base(), store);
  assert.equal(analysis.decision, 'ELIGIBLE');
  assert.equal(final.decision, 'WOULD_DISPATCH_CLAUDE');
  assert.equal(final.cycle, 1);
  assert.equal(final.idempotencyKey, `codex-fix:pr-7:${HEAD}:code_review`);
  assert.deepEqual([...store.refs.keys()].sort(), [G.cycleRef(7, 1), G.shaRef(7, HEAD)].sort());
});

test('doublons inter-exécutions : créé, édité, rejoué → une seule réservation', async () => {
  const store = new G.MemoryStore();
  const r1 = await G.simulate(base({ payload: S.summaryEvent({ action: 'created' }), runId: '1' }), store);
  const r2 = await G.simulate(base({ payload: S.summaryEvent({ action: 'edited' }), runId: '2' }), store);
  const r3 = await G.simulate(base({ runId: '1' }), store); // relance de la même exécution
  assert.equal(r1.final.decision, 'WOULD_DISPATCH_CLAUDE');
  assert.deepEqual([r2.final.reason, r3.final.reason], ['DUPLICATE_EVENT', 'DUPLICATE_EVENT']);
  assert.equal(r2.final.previous.runId, '1');
  assert.equal(store.refs.size, 2);
});

test('concurrence : 20 exécutions simultanées sur le même SHA → exactement 1 WOULD_DISPATCH_CLAUDE', async () => {
  const store = new G.MemoryStore();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => G.simulate(base({ runId: String(i + 1) }), store)));
  const decisions = results.map((r) => r.final.decision);
  assert.equal(decisions.filter((d) => d === 'WOULD_DISPATCH_CLAUDE').length, 1);
  assert.equal(results.filter((r) => r.final.reason === 'DUPLICATE_EVENT').length, 19);
  assert.equal(store.refs.size, 2);
});

test('concurrence : 3 SHA différents en parallèle → 2 cycles réservés, le 3e bloqué', async () => {
  const store = new G.MemoryStore();
  const results = await Promise.all([HEAD, SHA_D, SHA_E].map((sha, i) =>
    G.simulate(base({ api: S.findingApi({ sha }), runId: String(i + 1) }), store)));
  const reasons = results.map((r) => r.final.reason).sort();
  assert.deepEqual(reasons, ['CYCLE_LIMIT_REACHED', 'RESERVED_NO_DISPATCH_IN_B1', 'RESERVED_NO_DISPATCH_IN_B1']);
  assert.deepEqual(results.map((r) => r.final.cycle).filter(Boolean).sort(), [1, 2]);
  // Rejouer le SHA bloqué reste bloqué (jamais de réservation tardive)
  const blocked = results.find((r) => r.final.reason === 'CYCLE_LIMIT_REACHED').final.headSha;
  const again = await G.simulate(base({ api: S.findingApi({ sha: blocked }), runId: '9' }), store);
  assert.equal(again.final.reason, 'CYCLE_LIMIT_REACHED');
});

test('séquence réaliste : cycle 1, correction (nouveau SHA) cycle 2, 3e SHA refusé', async () => {
  const store = new G.MemoryStore();
  const steps = [];
  for (const sha of [HEAD, NEW_HEAD, SHA_D]) steps.push((await G.simulate(base({ api: S.findingApi({ sha }) }), store)).final);
  assert.deepEqual(steps.map((s) => [s.decision, s.cycle || null]),
    [['WOULD_DISPATCH_CLAUDE', 1], ['WOULD_DISPATCH_CLAUDE', 2], ['SKIP', null]]);
  assert.equal(steps[2].reason, 'CYCLE_LIMIT_REACHED');
});

test('nouvelle remarque (autre section) sur un SHA déjà traité : SKIP, pas de 2e tentative', async () => {
  const store = withSeed([{ pr: 7, sha: HEAD, sections: ['code_review'], cycle: 1 }]);
  const api = S.findingApi();
  api.issueComments = [S.summaryComment({ security: { commit_sha: HEAD, has_any_findings: true, has_unresolved_findings: true, status: 'completed' } })];
  const { final } = await G.simulate(base({ api }), store);
  assert.equal(final.reason, 'NEW_FINDING_ON_ATTEMPTED_SHA');
  assert.deepEqual(final.previous.sections, ['code_review']);
  assert.equal(final.idempotencyKey, `codex-fix:pr-7:${HEAD}:code_review+security_review`);
});

test('échec après réservation du SHA : UNVERIFIED puis verrou conservé (aucune nouvelle tentative)', async () => {
  let broken = true;
  const store = new G.MemoryStore({ faults: (op, name, phase) => broken && op === 'createRef' && /cycle/.test(name || '') && phase === 'before' });
  const r1 = (await G.simulate(base(), store)).final;
  assert.equal(r1.decision, 'UNVERIFIED');
  assert.equal(r1.reason, 'RESERVATION_INCOMPLETE');
  broken = false;
  const r2 = (await G.simulate(base({ runId: '2' }), store)).final;
  assert.equal(r2.decision, 'SKIP');
  assert.equal(r2.reason, 'SHA_LOCKED_WITHOUT_CYCLE');
  assert.ok(r2.notes.includes('MANUAL_UNLOCK_REQUIRED'));
});

test('réponse perdue après écriture : la relecture reconnaît la réservation, une seule fois', async () => {
  for (const pattern of [/\/sha\//, /\/cycle\//]) {
    let once = true;
    const store = new G.MemoryStore({ faults: (op, name, phase) => {
      if (once && op === 'createRef' && pattern.test(name) && phase === 'after') { once = false; return true; }
      return false;
    } });
    const r1 = (await G.simulate(base(), store)).final;
    assert.equal(r1.decision, 'WOULD_DISPATCH_CLAUDE', String(pattern));
    assert.equal((await G.simulate(base({ runId: '2' }), store)).final.reason, 'DUPLICATE_EVENT');
  }
});

test('erreur réseau avant toute réservation : UNVERIFIED, nouvelle tentative possible ensuite', async () => {
  let broken = true;
  const store = new G.MemoryStore({ faults: (op, name, phase) => broken && op === 'createRef' && phase === 'before' &&
    /\/sha\//.test(name) });
  const r1 = (await G.simulate(base(), store)).final;
  // getRef de récupération ne trouve rien : rien n'est réservé
  assert.equal(r1.decision, 'UNVERIFIED');
  assert.ok(r1.notes.includes('NOTHING_RESERVED'));
  broken = false;
  assert.equal((await G.simulate(base(), store)).final.decision, 'WOULD_DISPATCH_CLAUDE');
});

test('enregistrement illisible ou falsifié sous un verrou : SKIP (échec sûr)', async () => {
  const store = new G.MemoryStore();
  store.objects.set('f'.repeat(40), 'codex-gate-record:v1\n{"v":1,"kind":"reservation","key":"$(rm -rf /)"}');
  store.refs.set(G.shaRef(7, HEAD), 'f'.repeat(40));
  const { final } = await G.simulate(base(), store);
  assert.equal(final.reason, 'SHA_ALREADY_RESERVED');
  assert.ok(final.notes.includes('RECORD_UNREADABLE'));
});

// --- Garde-fous ----------------------------------------------------------------

test('branches autorisées : claude/* seulement, jamais main ni segments douteux', () => {
  for (const ok of ['claude/codex-feedback-gate', 'claude/a/b', 'claude/fix_1.2']) assert.equal(G.isAllowedBranch(ok, 'main'), true, ok);
  for (const ko of ['main', 'master', 'feature/x', 'claude', 'claude/', 'claude/../main', 'claude/.hidden', 'claude/x.lock',
    'Claude/x', 'claude/x y', 'claude/$(id)', 'refs/heads/claude/x', '', null, 'claude/' + 'a'.repeat(250)]) {
    assert.equal(G.isAllowedBranch(ko, 'main'), false, String(ko));
  }
  assert.equal(G.isAllowedBranch('claude/main', 'claude/main'), false, 'branche par défaut refusée même si elle commence par claude/');
});

test('PR : forks (existant ou supprimé), autre dépôt, données incomplètes', () => {
  const pr = (o) => S.pullRequest(o);
  assert.equal(G.checkPullRequest(pr(), REPO), null);
  assert.equal(G.checkPullRequest(pr(), REPO.toLowerCase()), null, 'nom de dépôt insensible à la casse');
  assert.equal(G.checkPullRequest(pr({ headRepo: null }), REPO).reason, 'HEAD_REPO_NOT_ALLOWED');
  assert.equal(G.checkPullRequest(pr({ headRepo: { full_name: REPO, fork: true } }), REPO).reason, 'HEAD_REPO_NOT_ALLOWED');
  assert.equal(G.checkPullRequest(pr({ headRepo: { full_name: REPO } }), REPO).reason, 'HEAD_REPO_NOT_ALLOWED', 'fork non précisé');
  assert.equal(G.checkPullRequest(pr({ headRepo: { full_name: 'x/TestDoubleIA', fork: false } }), REPO).reason, 'HEAD_REPO_NOT_ALLOWED');
  const other = pr(); other.base.repo.full_name = 'x/y';
  assert.equal(G.checkPullRequest(other, REPO).reason, 'BASE_REPO_MISMATCH');
  const noLabels = pr(); delete noLabels.labels;
  assert.equal(G.checkPullRequest(noLabels, REPO).decision, 'UNVERIFIED');
  assert.equal(G.checkPullRequest(null, REPO).decision, 'UNVERIFIED');
  assert.equal(G.checkPullRequest(pr({ user: { login: 'dependabot[bot]', id: 1, type: 'Bot' } }), REPO).reason, 'AUTHOR_NOT_TRUSTED');
});

test('droits de l\'auteur : admin/write acceptés, read/triage/none refusés, inconnu → UNVERIFIED', () => {
  assert.equal(G.checkPermission('admin'), null);
  assert.equal(G.checkPermission('write'), null);
  for (const p of ['read', 'triage', 'none', 'maintain ', '', null]) assert.equal(G.checkPermission(p).reason, 'AUTHOR_NOT_TRUSTED', String(p));
  assert.equal(G.checkPermission(undefined).decision, 'UNVERIFIED');
});

test('auteur imité : login identique mais identifiant ou type différent → aucune analyse', async () => {
  for (const fake of [{ ...S.CODEX_USER, id: 1 }, { ...S.CODEX_USER, type: 'User' }, { login: 'chatgpt-codex-connector', id: 199175422, type: 'Bot' }]) {
    const { final } = await G.simulate(base({ payload: S.summaryEvent({ sender: fake }) }));
    assert.equal(final.reason, 'SENDER_NOT_CODEX');
    const r = await G.simulate(base({ payload: S.summaryEvent({ sender: fake, comment: S.summaryComment({ user: fake }) }) }));
    assert.equal(r.final.reason, 'TRIGGER_NOT_FROM_CODEX');
  }
});

test('simple mention @codex par un humain : SKIP sans appel API', async () => {
  const fake = fakeGitHub();
  const payload = S.summaryEvent({ action: 'created', sender: S.OWNER, comment: { ...S.summaryComment({ user: S.OWNER }), body: '@codex review' } });
  const { dir, env } = runEnv('analyze', {}, payload);
  const r = await G.run(env, { fetch: fake.fetch, out: () => {} });
  assert.equal(r.decision, 'SKIP');
  assert.equal(r.reason, 'TRIGGER_NOT_FROM_CODEX');
  assert.equal(fake.calls.length, 0);
  fs.rmSync(dir, { recursive: true });
});

test('lancement manuel evaluate-pr : éligibilité indiquée mais jamais de réservation', async () => {
  const r = await G.simulate(base({ eventName: 'workflow_dispatch', payload: { inputs: { pr_number: '7' } } }));
  assert.equal(r.final.decision, 'SKIP');
  assert.equal(r.final.reason, 'MANUAL_EVALUATION_ONLY');
  assert.equal(r.final.wouldBeEligible, true);
});

test('événements non pris en charge (pull_request_review, push…) : SKIP', async () => {
  for (const ev of ['pull_request_review', 'pull_request_review_comment', 'pull_request_target', 'push']) {
    const { final } = await G.simulate(base({ eventName: ev }));
    assert.equal(final.decision, 'SKIP', ev);
  }
});

// --- Exécution complète contre un faux GitHub ----------------------------------

test('exécution analyze : uniquement des lectures, sorties validées, aucun texte non fiable', async () => {
  const fake = fakeGitHub();
  const lines = [];
  const { dir, env, files } = runEnv('analyze');
  const r = await G.run(env, { fetch: fake.fetch, out: (s) => lines.push(s) });
  assert.equal(r.decision, 'ELIGIBLE');
  for (const c of fake.calls) {
    assert.ok(c.method === 'GET' || (c.method === 'POST' && c.url.endsWith('/graphql')), `${c.method} ${c.url}`);
    if (c.method === 'POST') assert.doesNotMatch(c.body.query, /mutation/i);
  }
  const output = read(files.output);
  assert.equal(output, `decision=ELIGIBLE\nreason=ELIGIBLE_PENDING_RESERVATION\neligible=true\npr_number=7\nhead_sha=${HEAD}\nsections=code_review\n`);
  const all = lines.join('\n') + read(files.summary) + output;
  assert.doesNotMatch(all, /curl|rm -rf|evil|Ignore previous|@claude|jeton-factice/i);
  fs.rmSync(dir, { recursive: true });
});

test('exécution reserve : persistance réelle entre exécutions via les refs Git (faux GitHub partagé)', async () => {
  const git = { refs: new Map(), tags: new Map(), n: 0 };
  const inputs = { GATE_PR_NUMBER: '7', GATE_HEAD_SHA: HEAD, GATE_SECTIONS: 'code_review' };
  const results = [];
  for (const runId of ['1001', '1002']) { // deux exécutions distinctes, sans mémoire partagée hors de GitHub
    const fake = fakeGitHub({ git });
    const { dir, env } = runEnv('reserve', { ...inputs, GITHUB_RUN_ID: runId });
    results.push(await G.run(env, { fetch: fake.fetch, out: () => {} }));
    for (const c of fake.calls.filter((x) => x.method !== 'GET')) {
      assert.ok(/\/git\/(tags|refs)$/.test(c.url), c.url);
      if (c.url.endsWith('/git/refs')) assert.match(c.body.ref, /^refs\/codex-gate\/v1\/pr-7\/(sha|cycle)\//);
    }
    fs.rmSync(dir, { recursive: true });
  }
  assert.equal(results[0].decision, 'WOULD_DISPATCH_CLAUDE');
  assert.equal(results[1].reason, 'DUPLICATE_EVENT');
  assert.equal(results[1].previous.runId, '1001');
  assert.deepEqual([...git.refs.keys()].sort(), [G.cycleRef(7, 1), G.shaRef(7, HEAD)].sort());
  const rec = G.parseRecord(git.tags.get(git.refs.get(G.shaRef(7, HEAD))).message);
  assert.equal(rec.key, `codex-fix:pr-7:${HEAD}:code_review`);
});

test('exécution reserve : concurrence réelle contre le faux GitHub → un seul gagnant', async () => {
  const git = { refs: new Map(), tags: new Map(), n: 0 };
  const results = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
    const { dir, env } = runEnv('reserve', { GATE_PR_NUMBER: '7', GATE_HEAD_SHA: HEAD, GATE_SECTIONS: 'code_review', GITHUB_RUN_ID: String(2000 + i) });
    const r = await G.run(env, { fetch: fakeGitHub({ git }).fetch, out: () => {} });
    fs.rmSync(dir, { recursive: true });
    return r;
  }));
  assert.equal(results.filter((r) => r.decision === 'WOULD_DISPATCH_CLAUDE').length, 1);
  assert.equal(results.filter((r) => r.reason === 'DUPLICATE_EVENT').length, 7);
});

test('exécution reserve : SHA obsolète, PR fermée, auteur non collaborateur revérifiés côté écriture', async () => {
  const cases = [
    [S.findingApi({ sha: NEW_HEAD }), 'admin', 'STALE_SHA'],
    [S.findingApi({ state: 'closed' }), 'admin', 'PR_NOT_OPEN'],
    [S.findingApi(), null, 'AUTHOR_NOT_TRUSTED'],
    [S.findingApi({ ref: 'main' }), 'admin', 'BRANCH_NOT_ALLOWED']
  ];
  for (const [api, permission, reason] of cases) {
    const fake = fakeGitHub({ api, permission });
    const { dir, env } = runEnv('reserve', { GATE_PR_NUMBER: '7', GATE_HEAD_SHA: HEAD, GATE_SECTIONS: 'code_review' });
    const r = await G.run(env, { fetch: fake.fetch, out: () => {} });
    assert.equal(r.reason, reason);
    assert.equal(fake.calls.filter((c) => c.method !== 'GET').length, 0, `aucune écriture (${reason})`);
    fs.rmSync(dir, { recursive: true });
  }
});

test('exécution reserve : entrées injectées ou interrupteur coupé → aucun appel API', async () => {
  const bad = [
    { GATE_PR_NUMBER: '7; rm -rf /', GATE_HEAD_SHA: HEAD, GATE_SECTIONS: 'code_review' },
    { GATE_PR_NUMBER: '7', GATE_HEAD_SHA: 'main', GATE_SECTIONS: 'code_review' },
    { GATE_PR_NUMBER: '7', GATE_HEAD_SHA: HEAD, GATE_SECTIONS: 'code_review+../../heads/main' },
    { GATE_PR_NUMBER: '7', GATE_HEAD_SHA: HEAD, GATE_SECTIONS: '' },
    { GATE_PR_NUMBER: '0', GATE_HEAD_SHA: HEAD, GATE_SECTIONS: 'code_review' }
  ];
  for (const inputs of bad) {
    const fake = fakeGitHub();
    const { dir, env } = runEnv('reserve', inputs);
    const r = await G.run(env, { fetch: fake.fetch, out: () => {} });
    assert.equal(r.reason, 'INVALID_INPUT', JSON.stringify(inputs));
    assert.equal(fake.calls.length, 0);
    fs.rmSync(dir, { recursive: true });
  }
  const fake = fakeGitHub();
  const { dir, env } = runEnv('reserve', { GATE_PR_NUMBER: '7', GATE_HEAD_SHA: HEAD, GATE_SECTIONS: 'code_review', CODEX_GATE_ENABLED: 'false' });
  const r = await G.run(env, { fetch: fake.fetch, out: () => {} });
  assert.equal(r.reason, 'GATE_DISABLED');
  assert.equal(fake.calls.length, 0);
  fs.rmSync(dir, { recursive: true });
});

test('interrupteur global absent : analyse en SKIP GATE_DISABLED (éligibilité seulement indiquée)', async () => {
  const fake = fakeGitHub();
  const { dir, env, files } = runEnv('analyze', { CODEX_GATE_ENABLED: '' });
  const r = await G.run(env, { fetch: fake.fetch, out: () => {} });
  assert.equal(r.reason, 'GATE_DISABLED');
  assert.equal(r.wouldBeEligible, true);
  assert.match(read(files.output), /eligible=false/);
  assert.doesNotMatch(read(files.output), /pr_number=/);
  fs.rmSync(dir, { recursive: true });
});

test('erreur réseau ou API pendant l\'analyse : UNVERIFIED API_ERROR', async () => {
  const { dir, env } = runEnv('analyze');
  const r1 = await G.run(env, { fetch: async () => { throw new Error('ECONNRESET'); }, out: () => {} });
  assert.deepEqual([r1.decision, r1.reason], ['UNVERIFIED', 'API_ERROR']);
  const fake = fakeGitHub({ hook: (m, url) => (url.endsWith('/permission') ? response(500, {}) : null) });
  const r2 = await G.run(env, { fetch: fake.fetch, out: () => {} });
  assert.deepEqual([r2.decision, r2.reason], ['UNVERIFIED', 'API_ERROR']);
  fs.rmSync(dir, { recursive: true });
});

test('dépassement du quota d\'API (403 remaining=0, 429) : UNVERIFIED API_RATE_LIMITED', async () => {
  const limited = (status, headers) => fakeGitHub({ hook: (m, url) => (url.includes('/pulls/7') && !url.includes('/comments') &&
    !url.includes('/reviews') ? response(status, { message: 'API rate limit exceeded' }, headers) : null) });
  for (const [status, headers] of [[403, { 'x-ratelimit-remaining': '0' }], [429, { 'retry-after': '60' }]]) {
    const { dir, env } = runEnv('analyze');
    const r = await G.run(env, { fetch: limited(status, headers).fetch, out: () => {} });
    assert.deepEqual([r.decision, r.reason], ['UNVERIFIED', 'API_RATE_LIMITED'], String(status));
    fs.rmSync(dir, { recursive: true });
  }
  // Quota atteint pendant la réservation : rien n'est considéré comme réservé
  const fake = fakeGitHub({ hook: (m, url) => (m === 'POST' && url.endsWith('/git/refs') ? response(403, {}, { 'x-ratelimit-remaining': '0' }) : null) });
  const { dir, env } = runEnv('reserve', { GATE_PR_NUMBER: '7', GATE_HEAD_SHA: HEAD, GATE_SECTIONS: 'code_review' });
  const r = await G.run(env, { fetch: fake.fetch, out: () => {} });
  assert.deepEqual([r.decision, r.reason], ['UNVERIFIED', 'API_RATE_LIMITED']);
  assert.ok(r.notes.includes('NOTHING_RESERVED'));
  fs.rmSync(dir, { recursive: true });
});

test('403 sans indicateur de quota : erreur d\'API ordinaire, pas de quota supposé', () => {
  assert.equal(G.isRateLimited(response(403, {})), false);
  assert.equal(G.isRateLimited(response(403, {}, { 'x-ratelimit-remaining': '0' })), true);
  assert.equal(G.isRateLimited(response(429, {})), true);
});

test('GitRefStore : 422 autre que « already exists » est une erreur, jamais un doublon', async () => {
  const fake = fakeGitHub({ hook: (m, url) => (m === 'POST' && url.endsWith('/git/refs') ? response(422, { message: 'Object does not exist' }) : null) });
  const store = new G.GitRefStore(ctxFor(fake));
  await assert.rejects(store.createRef(G.shaRef(7, HEAD), 'f'.repeat(40)), /HTTP 422/);
});

test('les refs manipulées sont confinées à refs/codex-gate/v1/**', async () => {
  for (const ko of ['refs/heads/main', 'refs/tags/v1', 'refs/codex-gate/v1/pr-7/sha/../../../heads/main', 'refs/codex-gate/v1/pr-7/cycle/0',
    'refs/codex-gate/v1/pr-7/cycle/10', 'refs/codex-gate/v2/pr-7/cycle/1', `refs/codex-gate/v1/pr-07/sha/${HEAD}`, 'refs/codex-gate/v1/selftest/1/UP']) {
    assert.throws(() => G.assertGateRef(ko), /hors de l'espace/, ko);
  }
  const fake = fakeGitHub();
  const store = new G.GitRefStore(ctxFor(fake));
  await assert.rejects(store.createRef('refs/heads/main', HEAD));
  await assert.rejects(store.deleteRef('refs/heads/main'));
  await assert.rejects(new G.MemoryStore().createRef('refs/heads/main', HEAD));
  assert.equal(fake.calls.length, 0);
});

test('enregistrements : format strict, taille bornée, aucun champ non validé accepté', () => {
  const ok = { v: 1, kind: 'reservation', key: `codex-fix:pr-7:${HEAD}:code_review`, pr: 7, sha: HEAD, sections: ['code_review'], runId: '1' };
  assert.deepEqual(G.parseRecord(G.serializeRecord(ok)), ok);
  for (const bad of [
    null, '', '{"v":1}', G.serializeRecord({ ...ok, v: 2 }), G.serializeRecord({ ...ok, key: 'x' }),
    G.serializeRecord({ ...ok, sections: ['shell'] }), G.serializeRecord({ ...ok, sha: 'main' }),
    G.serializeRecord({ ...ok, pr: '7' }), G.serializeRecord({ ...ok, pad: 'x'.repeat(3000) }), 'codex-gate-record:v1\n{pas du json'
  ]) assert.equal(G.parseRecord(bad), null, String(bad).slice(0, 60));
});

// --- Auto-test du stockage ---------------------------------------------------

test('auto-test du stockage : PASS sur un stockage atomique (mémoire et faux GitHub), refs nettoyées', async () => {
  const mem = await G.storeSelfTest(new G.MemoryStore(), { runId: '42', commitSha: HEAD });
  assert.equal(mem.ok, true, JSON.stringify(mem.checks));
  const fake = fakeGitHub();
  const { dir, env } = runEnv('self-test', { GITHUB_SHA: HEAD, GITHUB_RUN_ID: '43' });
  const r = await G.run(env, { fetch: fake.fetch, out: () => {} });
  assert.equal(r.decision, 'PASS', JSON.stringify(r.notes));
  assert.equal(fake.git.refs.size, 0, 'refs temporaires supprimées');
  for (const c of fake.calls.filter((x) => x.method === 'POST' && x.url.endsWith('/git/refs'))) {
    assert.match(c.body.ref, /^refs\/codex-gate\/v1\/selftest\/43\//);
  }
  fs.rmSync(dir, { recursive: true });
});

test('auto-test du stockage : FAIL si la création n\'est pas atomique', async () => {
  class Racy extends G.MemoryStore {
    async createRef(name, target) {
      G.assertGateRef(name);
      const had = this.refs.has(name);
      await this.tick(); // vérification puis écriture séparées : non atomique
      if (had) return 'exists';
      this.refs.set(name, target);
      return 'created';
    }
  }
  const prev = process.exitCode;
  const r = await G.storeSelfTest(new Racy(), { runId: '44', commitSha: HEAD });
  process.exitCode = prev;
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((c) => c.name === 'CONCURRENT_SINGLE_WINNER' && !c.ok));
});

// --- Workflow : propriétés de sécurité vérifiées statiquement ----------------

test('workflow : déclencheurs limités, aucune permission par défaut, écriture limitée à contents', () => {
  const on = WORKFLOW.split('\non:\n')[1].split('\npermissions:')[0];
  assert.deepEqual([...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]), ['issue_comment', 'workflow_dispatch']);
  assert.match(WORKFLOW, /^permissions: \{\}$/m);
  const writes = [...WORKFLOW.matchAll(/^\s+([a-z-]+): write\b/gm)].map((m) => m[1]);
  assert.deepEqual(writes, ['contents', 'contents'], 'seuls reserve et store-self-test écrivent, et uniquement contents');
  assert.doesNotMatch(WORKFLOW, /write-all|read-all|pull_request_target|pull_request_review/);
  assert.doesNotMatch(WORKFLOW, /secrets\./);
  assert.doesNotMatch(WORKFLOW, /ANTHROPIC|claude-code-action|anthropic_api_key|oauth/i);
  assert.doesNotMatch(WORKFLOW, /allowed_bots/);
});

test('workflow : jobs d\'écriture séparés, conditionnés et sans code de PR', () => {
  const jobs = WORKFLOW.split('\njobs:\n')[1];
  const reserve = jobs.split('\n  reserve:\n')[1].split('\n  store-self-test:\n')[0];
  assert.match(reserve, /needs: analyze/);
  assert.match(reserve, /github\.event_name == 'issue_comment'/);
  assert.match(reserve, /needs\.analyze\.outputs\.eligible == 'true'/);
  assert.match(reserve, /vars\.CODEX_GATE_ENABLED == 'true'/);
  assert.match(reserve, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(reserve, /cancel-in-progress: false/);
  const selfTest = jobs.split('\n  store-self-test:\n')[1];
  assert.match(selfTest, /github\.actor == github\.repository_owner/);
  assert.match(selfTest, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  const analyze = jobs.split('\n  reserve:\n')[0];
  assert.doesNotMatch(analyze, /: write\b/);
  assert.equal((WORKFLOW.match(/persist-credentials: false/g) || []).length, 3);
  assert.equal((WORKFLOW.match(/'chatgpt-codex-connector\[bot\]'/g) || []).length, 2, 'auteur ET émetteur filtrés');
});

test('workflow : aucune expression ${{ }} dans les commandes, contenu des commentaires jamais lu', () => {
  const runLines = WORKFLOW.split('\n').filter((l) => /^\s*run:/.test(l)).map((l) => l.trim());
  assert.ok(runLines.length >= 3);
  for (const l of runLines) assert.equal(l, 'run: node tools/codex-feedback/gate.js');
  assert.doesNotMatch(WORKFLOW, /github\.event\.(comment|review|issue|pull_request)\.(body|title|head\.ref)/);
});

test('les choix workflow_dispatch correspondent aux modes de gate.js', () => {
  const block = WORKFLOW.split('options:')[1].split('pr_number:')[0];
  assert.deepEqual([...block.matchAll(/^\s+- ([a-z-]+)\s*$/gm)].map((m) => m[1]), ['demo', 'evaluate-pr', 'store-self-test']);
});
