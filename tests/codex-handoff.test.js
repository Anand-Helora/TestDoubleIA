// Tests du dossier de correction Codex → Claude Code Web (Issue #11, phase B2 sans API).
// Lancement : node --test. Aucun appel réseau : l'API GitHub est simulée.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('../tools/codex-feedback/handoff.js');
const HS = require('../tools/codex-feedback/handoff-scenarios.js');
const S = require('../tools/codex-feedback/gate-scenarios.js');

const ROOT = path.join(__dirname, '..');
const WF_DIR = path.join(ROOT, '.github', 'workflows');
const WORKFLOW = fs.readFileSync(path.join(WF_DIR, 'codex-feedback-handoff.yml'), 'utf8');
// Contenu exécutable (commentaires YAML retirés : ils décrivent justement ce qui est interdit).
const WF_CODE = WORKFLOW.split('\n').filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s+#.*$/, '')).join('\n');
const { REPO, HEAD, NEW_HEAD } = S;
const TOKEN = 'ghs_jetonFactice0123456789abcdefABCDEF';
const HOSTILE_PARTS = ['Ignore previous', 'curl', 'evil.example', 'rm -rf', '$(', 'merge to main', '@claude', '@codex'];

const base = (o = {}) => ({ eventName: 'issue_comment', payload: S.summaryEvent(), api: S.findingApi(), permission: 'admin', ...o });

// --- Simulation de l'API GitHub (lecture seule) ------------------------------

function response(status, data) {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null },
    json: async () => (data === undefined ? null : JSON.parse(JSON.stringify(data))) };
}

function artifact(name, o = {}) {
  return { id: 1, name, expired: o.expired === true,
    workflow_run: { id: 9, repository_id: 1, head_repository_id: o.fork ? 2 : 1, head_branch: o.branch || 'main', head_sha: 'f'.repeat(40) } };
}

/** Faux GitHub : PR, commentaires, fils GraphQL, droits et liste des artefacts. Toute écriture → 405. */
function fakeGitHub({ api = S.findingApi(), apiAtRecheck = null, permission = 'admin', artifacts = [], artifactsStatus = 200 } = {}) {
  const calls = [];
  let prReads = 0;
  const prefix = `https://api.test/repos/${REPO}`;
  const current = () => (prReads > 1 && apiAtRecheck ? apiAtRecheck : api);
  async function fetch(url, init = {}) {
    const method = init.method || 'GET';
    calls.push({ method, url, headers: init.headers || {}, body: init.body || null });
    if (url === 'https://api.test/graphql') {
      const nodes = Object.entries(current().threads || {}).map(([id, t]) => ({ ...t, comments: { nodes: [{ fullDatabaseId: id }] } }));
      return response(200, { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes } } } } });
    }
    if (method !== 'GET') return response(405, { message: 'écriture interdite dans ce test' });
    const p = url.startsWith(prefix) ? url.slice(prefix.length) : null;
    if (p === null) return response(404, {});
    const pathOnly = p.replace(/\?.*$/, '');
    if (pathOnly === '/pulls/7') { prReads += 1; return response(200, current().pr); }
    if (pathOnly === '/issues/7/comments') return response(200, current().issueComments);
    if (pathOnly === '/pulls/7/reviews') return response(200, current().reviews);
    if (pathOnly === '/pulls/7/comments') return response(200, current().reviewComments);
    if (/^\/collaborators\/[^/]+\/permission$/.test(pathOnly)) return response(200, { permission });
    if (pathOnly === '/actions/artifacts') {
      if (artifactsStatus !== 200) return response(artifactsStatus, { message: 'Forbidden' });
      const name = new URL(url).searchParams.get('name');
      const list = artifacts.filter((a) => a.name === name);
      return response(200, { total_count: list.length, artifacts: list });
    }
    return response(404, {});
  }
  return { fetch, calls };
}

function runEnv(extra = {}, payload = S.summaryEvent(), eventName = 'issue_comment') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-handoff-'));
  const eventPath = path.join(dir, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify(payload));
  const files = { summary: path.join(dir, 'summary.md'), output: path.join(dir, 'output.txt'), dossier: path.join(dir, 'out', 'dossier-correction.md') };
  return {
    dir, files,
    env: {
      HANDOFF_PHASE: 'prepare', HANDOFF_DIR: path.join(dir, 'out'), GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath,
      GITHUB_TOKEN: TOKEN, GITHUB_REPOSITORY: REPO, GITHUB_REPOSITORY_OWNER: 'Anand-Helora', GITHUB_ACTOR: 'chatgpt-codex-connector[bot]',
      GITHUB_API_URL: 'https://api.test', GITHUB_GRAPHQL_URL: 'https://api.test/graphql',
      GITHUB_STEP_SUMMARY: files.summary, GITHUB_OUTPUT: files.output, ...extra
    }
  };
}
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');

function assertNoHostileText(text) {
  for (const part of HOSTILE_PARTS) assert.ok(!text.includes(part), `texte non fiable relayé : ${part}`);
}

// --- Scénarios : décisions positives et négatives -----------------------------

for (const sc of HS.scenarios()) {
  test(`B2 scénario : ${sc.name}`, async () => {
    const r = await HS.simulate(sc);
    assert.equal(r.status, sc.expected.status);
    assert.equal(r.reason, sc.expected.reason);
    assert.equal(r.handoff, sc.expected.status === 'HANDOFF_READY');
    if (r.status !== 'HANDOFF_READY') assert.equal(r.dossier, undefined);
  });
}

test('B2 : dossier complet — dépôt, PR, branche, SHA, sections, priorités, permaliens, consignes fixes', async () => {
  const r = await HS.simulate(base());
  assert.equal(r.status, 'HANDOFF_READY');
  const d = r.dossier;
  assert.match(d, new RegExp(`Dépôt : ${REPO}`));
  assert.match(d, new RegExp(`https://github.com/${REPO}/pull/7\\b`));
  assert.match(d, /Branche de la PR : claude\/demo-fix/);
  assert.match(d, new RegExp(`SHA courant examiné par Codex : ${HEAD}`));
  assert.match(d, /code_review \(revue de code\)/);
  assert.match(d, /\[P2\] code_review — remarque inline — https:\/\/github\.com\/Anand-Helora\/TestDoubleIA\/pull\/7#discussion_r701/);
  assert.match(d, /#issuecomment-901/);
  assert.match(d, /Lis la PR #7/);
  assert.match(d, /Examine chacune des remarques Codex/);
  assert.match(d, /Corrige les anomalies justifiées dans la même branche claude\/demo-fix/);
  assert.match(d, /Ajoute ou adapte des tests/);
  assert.match(d, /N'effectue aucune fusion/);
  assert.match(d, /aucune correction n'a été exécutée/);
  assert.equal(r.artifactName, `codex-handoff-pr-7-${HEAD}-code_review`);
  assert.deepEqual(r.findingUrls, [`https://github.com/${REPO}/pull/7#discussion_r701`, `https://github.com/${REPO}/pull/7#issuecomment-901`]);
});

test('B2 : injection en commentaire — aucun texte de commentaire, aucune mention, aucune commande relayée', async () => {
  const r = await HS.simulate(base());
  assertNoHostileText(r.dossier);
  assert.ok(!r.dossier.includes('@'), 'aucune mention « @ » dans le dossier');
  assert.ok(!r.dossier.includes('`'), 'aucun bloc de code dans le dossier');
  assertNoHostileText(H.renderSummary(r, H.TITLE));
  assertNoHostileText(JSON.stringify(r));
});

test('B2 : chaque ligne du dossier provient du modèle fixe ou de valeurs validées', async () => {
  const r = await HS.simulate(base());
  const allowed = /^[\p{L}\p{N} .,:;'’«»()\[\]#\/\-—_+=!?…]*$/u;
  for (const line of r.dossier.split('\n')) assert.match(line, allowed);
});

test('B2 : sections code + sécurité → une seule clé triée, artefact déterministe', async () => {
  const api = S.findingApi();
  api.issueComments = [S.summaryComment({ security: { commit_sha: HEAD, has_any_findings: true, has_unresolved_findings: true, status: 'completed' } })];
  const r = await HS.simulate(base({ api }));
  assert.equal(r.status, 'HANDOFF_READY');
  assert.equal(r.idempotencyKey, `codex-fix:pr-7:${HEAD}:code_review+security_review`);
  assert.equal(r.artifactName, `codex-handoff-pr-7-${HEAD}-code_review-security_review`);
  assert.match(r.dossier, /security_review \(revue de sécurité\)/);
});

test('B2 : limite de 2 cycles atteinte → NO_HANDOFF', async () => {
  const api = S.findingApi();
  api.reviewComments.push(S.inlineComment({ id: 702, reviewId: 802, sha: 'd'.repeat(40) }), S.inlineComment({ id: 703, reviewId: 803, sha: 'e'.repeat(40) }));
  const r = await HS.simulate(base({ api }));
  assert.deepEqual([r.status, r.reason], ['NO_HANDOFF', 'CYCLE_LIMIT_REACHED']);
});

test('B2 : signal ambigu (résumé propre, fil non résolu) → UNVERIFIED', async () => {
  const api = S.findingApi({ unresolved: false });
  const r = await HS.simulate(base({ api }));
  assert.deepEqual([r.status, r.reason], ['UNVERIFIED', 'CONTRADICTORY_SIGNALS']);
});

test('B2 : statut de fil inconnu → UNVERIFIED', async () => {
  const api = S.findingApi();
  api.threads = null;
  api.issueComments = [];
  const r = await HS.simulate(base({ api }));
  assert.equal(r.status, 'UNVERIFIED');
});

test('B2 : label d\'arrêt codex-gate:stop → NO_HANDOFF', async () => {
  const r = await HS.simulate(base({ api: S.findingApi({ labels: [{ name: 'codex-gate:stop' }] }) }));
  assert.deepEqual([r.status, r.reason], ['NO_HANDOFF', 'STOPPED_BY_LABEL']);
});

test('B2 : droit retiré entre la lecture et la revérification → NO_HANDOFF', async () => {
  let n = 0;
  const r = await H.prepare({ eventName: 'issue_comment', payload: S.summaryEvent(), repo: REPO,
    loadApi: async () => S.findingApi(), loadPermission: async () => (++n > 1 ? 'read' : 'admin'), hasHandoff: async () => false });
  assert.deepEqual([r.status, r.reason], ['NO_HANDOFF', 'AUTHOR_NOT_TRUSTED']);
});

test('B2 : PR fermée entre la lecture et la revérification → NO_HANDOFF', async () => {
  const r = await HS.simulate(base({ apiAtRecheck: S.findingApi({ state: 'closed' }) }));
  assert.deepEqual([r.status, r.reason], ['NO_HANDOFF', 'PR_NOT_OPEN']);
});

test('B2 : nouvelle section apparue à la revérification → UNVERIFIED RECHECK_MISMATCH', async () => {
  const later = S.findingApi();
  later.issueComments = [S.summaryComment({ security: { commit_sha: HEAD, has_any_findings: true, has_unresolved_findings: true, status: 'completed' } })];
  const r = await HS.simulate(base({ apiAtRecheck: later }));
  assert.deepEqual([r.status, r.reason], ['UNVERIFIED', 'RECHECK_MISMATCH']);
});

test('B2 : erreurs API et déduplication indisponible → UNVERIFIED, aucun dossier', async () => {
  const e = Object.assign(new Error('x'), { status: 502 });
  const r1 = await HS.simulate(base({ apiError: e }));
  assert.deepEqual([r1.status, r1.reason, r1.notes], ['UNVERIFIED', 'API_ERROR', ['HTTP_502']]);
  const r2 = await HS.simulate(base({ seenError: e }));
  assert.deepEqual([r2.status, r2.reason], ['UNVERIFIED', 'DEDUP_UNAVAILABLE']);
  const r3 = await H.prepare({ eventName: 'issue_comment', payload: S.summaryEvent(), repo: REPO, loadApi: async () => S.findingApi(),
    loadPermission: async () => 'admin', hasHandoff: async () => 'peut-être' });
  assert.deepEqual([r3.status, r3.reason], ['UNVERIFIED', 'DEDUP_UNAVAILABLE']);
});

test('B2 : événements et contextes non pris en charge', async () => {
  const r1 = await H.prepare({ eventName: 'pull_request_review', payload: {}, repo: REPO });
  assert.deepEqual([r1.status, r1.reason], ['NO_HANDOFF', 'UNSUPPORTED_EVENT']);
  const r2 = await H.prepare({ eventName: 'issue_comment', payload: S.summaryEvent(), repo: '' });
  assert.deepEqual([r2.status, r2.reason], ['UNVERIFIED', 'MISSING_CONTEXT']);
  const r3 = await H.prepare({ eventName: 'issue_comment', payload: 'pas un objet', repo: REPO });
  assert.deepEqual([r3.status, r3.reason], ['UNVERIFIED', 'MALFORMED_PAYLOAD']);
  const r4 = await H.prepare({ eventName: 'workflow_dispatch', payload: { inputs: { pr_number: '7; rm -rf /' } }, repo: REPO, trustedActor: true });
  assert.deepEqual([r4.status, r4.reason], ['UNVERIFIED', 'MALFORMED_PAYLOAD']);
});

test('B2 : authentification Codex — login seul, mauvais identifiant ou type ≠ Bot refusés', async () => {
  for (const sender of [
    { login: 'chatgpt-codex-connector[bot]', id: 1, type: 'Bot' },
    { login: 'chatgpt-codex-connector[bot]', id: 199175422, type: 'User' },
    { login: 'chatgpt-codex-connector', id: 199175422, type: 'Bot' }
  ]) {
    const r = await HS.simulate(base({ payload: S.summaryEvent({ sender }) }));
    assert.deepEqual([r.status, r.reason], ['NO_HANDOFF', 'SENDER_NOT_CODEX']);
  }
  const fakeApp = S.summaryComment();
  fakeApp.performed_via_github_app = { id: 1, slug: 'chatgpt-codex-connector' };
  const r = await HS.simulate(base({ payload: S.summaryEvent({ comment: fakeApp }) }));
  assert.deepEqual([r.status, r.reason], ['NO_HANDOFF', 'TRIGGER_NOT_FROM_CODEX']);
});

test('B2 : remarques d\'un auteur tiers imitant Codex ignorées dans l\'analyse', async () => {
  const api = S.cleanApi();
  api.reviewComments = [{ ...S.inlineComment(), user: S.OUTSIDER }];
  api.threads = { 701: { isResolved: false, isOutdated: false } };
  const r = await HS.simulate(base({ api }));
  assert.deepEqual([r.status, r.reason], ['NO_HANDOFF', 'NO_FINDINGS_ON_HEAD']);
});

// --- Permaliens --------------------------------------------------------------

test('B2 : permaliens malveillants ou incohérents refusés', () => {
  const f = (url, id = 'inline:701', section = 'code_review') => H.verifiedPermalink({ id, url, section }, REPO, 7);
  const good = `https://github.com/${REPO}/pull/7#discussion_r701`;
  assert.equal(f(good), good);
  assert.equal(f(good.replace('Anand-Helora/TestDoubleIA', 'anand-helora/testdoubleia')), good); // casse normalisée
  for (const bad of [
    'https://evil.example/Anand-Helora/TestDoubleIA/pull/7#discussion_r701',
    `https://github.com.evil.example/${REPO}/pull/7#discussion_r701`,
    `http://github.com/${REPO}/pull/7#discussion_r701`,
    `https://github.com/mallory/TestDoubleIA/pull/7#discussion_r701`,
    `https://github.com/${REPO}/pull/8#discussion_r701`,
    `https://github.com/${REPO}/pull/7#discussion_r702`,
    `https://github.com/${REPO}/pull/7#issuecomment-701`,
    `${good}?x=1`, `${good} `, `${good}\n::set-output`, 'javascript:alert(1)', `https://github.com/${REPO}/pull/7/../8#discussion_r701`
  ]) assert.equal(f(bad), null, bad);
  assert.equal(f(good, 'inline:abc'), null);
  assert.equal(f(good, 'review:701'), null);
  assert.equal(H.verifiedPermalink({ id: 'inline:701', url: null, section: 'code_review' }, REPO, 7), null);
  const sum = `https://github.com/${REPO}/pull/7#issuecomment-901`;
  assert.equal(f(sum, 'summary:901:code_review'), sum);
  assert.equal(f(sum, 'summary:901:security_review'), null); // section incohérente
  assert.equal(H.verifiedPermalink({ id: 'inline:701', url: good, section: 'code_review' }, 'pas un dépôt', 7), null);
});

test('B2 : grands identifiants GitHub (> 2^32) conservés dans les permaliens (données réelles PR #6)', async () => {
  const fx = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'codex', 'real-pr6-review.json'), 'utf8'));
  const api = fx.api;
  api.pr = { ...api.pr, user: S.OWNER, labels: [], head: { ...api.pr.head, ref: 'claude/codex-feedback-dryrun', repo: { full_name: REPO, fork: false } },
    base: { ref: 'main', repo: { full_name: REPO, default_branch: 'main' } } };
  const r = await H.prepare({ eventName: 'workflow_dispatch', payload: { inputs: { pr_number: '6' } }, repo: REPO, trustedActor: true,
    loadApi: async () => JSON.parse(JSON.stringify(api)), loadPermission: async () => 'admin', hasHandoff: async () => false });
  assert.equal(r.status, 'HANDOFF_READY');
  assert.ok(r.findingUrls.includes(`https://github.com/${REPO}/pull/6#discussion_r4518670008`));
  assert.ok(r.findingUrls.includes(`https://github.com/${REPO}/pull/6#discussion_r4518670017`));
});

// --- Secrets -----------------------------------------------------------------

test('B2 : détection de secrets', () => {
  for (const s of ['ghp_' + 'a'.repeat(36), 'ghs_' + 'B'.repeat(36), 'github_pat_' + 'c'.repeat(30), 'sk-ant-api03-' + 'x'.repeat(20),
    '-----BEGIN RSA PRIVATE KEY-----', 'Authorization: Bearer ' + 'z'.repeat(30), 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    assert.equal(H.containsSecret(`texte ${s} texte`), true, s);
  }
  assert.equal(H.containsSecret('valeur-secrete-xyz', { GITHUB_TOKEN: 'valeur-secrete-xyz' }), true);
  assert.equal(H.containsSecret('texte ordinaire', { GITHUB_TOKEN: 'valeur-secrete-xyz' }), false);
  assert.equal(H.containsSecret(null), true);
});

test('B2 : sortie contenant un secret → UNVERIFIED SECRET_PATTERN_DETECTED, aucun dossier écrit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-handoff-'));
  const files = { summary: path.join(dir, 's.md'), output: path.join(dir, 'o.txt') };
  const env = { GITHUB_TOKEN: TOKEN, GITHUB_STEP_SUMMARY: files.summary, GITHUB_OUTPUT: files.output, HANDOFF_DIR: path.join(dir, 'out') };
  const lines = [];
  const r = H.emit({ stage: 'handoff', prNumber: 7, handoff: true, status: 'HANDOFF_READY', reason: 'X',
    artifactName: `codex-handoff-pr-7-${HEAD}-code_review`, dossier: `fuite ${TOKEN}\n` }, env, { out: (s) => lines.push(s) }, H.TITLE);
  assert.deepEqual([r.status, r.reason], ['UNVERIFIED', 'SECRET_PATTERN_DETECTED']);
  const all = lines.join('\n') + read(files.summary) + read(files.output);
  assert.ok(!all.includes(TOKEN));
  assert.match(read(files.output), /handoff=false/);
  assert.equal(fs.existsSync(path.join(dir, 'out', 'dossier-correction.md')), false);
  fs.rmSync(dir, { recursive: true });
});

// --- Exécution complète avec une API simulée -----------------------------------

test('B2 run : revue authentique avec anomalie → résumé copiable, artefact, lectures seules, aucun secret', async () => {
  const fake = fakeGitHub();
  const { dir, env, files } = runEnv();
  const lines = [];
  const r = await H.run(env, { fetch: fake.fetch, out: (s) => lines.push(s) });
  assert.equal(r.status, 'HANDOFF_READY');
  const summary = read(files.summary);
  assert.match(summary, /### Dossier de correction — à copier dans Claude Code Web/);
  assert.match(summary, /````text\nDossier de correction Codex — PR #7/);
  assert.match(read(files.output), new RegExp(`status=HANDOFF_READY\\nreason=CONFIRMED_FINDINGS_HANDOFF_PREPARED\\nhandoff=true\\nartifact_name=codex-handoff-pr-7-${HEAD}-code_review\\n`));
  assert.equal(read(files.dossier), r.dossier);
  const all = lines.join('\n') + summary + read(files.output) + read(files.dossier);
  assert.ok(!all.includes(TOKEN), 'le jeton n\'apparaît jamais');
  assertNoHostileText(all);
  // Lectures seulement : GET REST + requête GraphQL de lecture (aucune mutation), hôte GitHub simulé uniquement.
  for (const c of fake.calls) {
    assert.ok(c.url.startsWith('https://api.test/'), c.url);
    assert.ok(c.method === 'GET' || (c.url.endsWith('/graphql') && /^\{"query":"query\(/.test(c.body)), `${c.method} ${c.url}`);
    assert.doesNotMatch(c.url, /anthropic|claude\.ai/i);
  }
  // Revérification : la PR est relue deux fois avant la préparation.
  assert.equal(fake.calls.filter((c) => c.url.endsWith('/pulls/7')).length, 2);
  assert.ok(fake.calls.some((c) => c.url.includes('/actions/artifacts?name=codex-handoff-pr-7-')));
  fs.rmSync(dir, { recursive: true });
});

test('B2 run : revue propre → NO_HANDOFF, pas de dossier ni d\'artefact', async () => {
  const fake = fakeGitHub({ api: S.cleanApi() });
  const { dir, env, files } = runEnv();
  const r = await H.run(env, { fetch: fake.fetch, out: () => {} });
  assert.deepEqual([r.status, r.reason], ['NO_HANDOFF', 'NO_FINDINGS_ON_HEAD']);
  assert.match(read(files.output), /handoff=false/);
  assert.doesNotMatch(read(files.output), /artifact_name/);
  assert.match(read(files.summary), /Aucun dossier de correction préparé/);
  assert.equal(fs.existsSync(files.dossier), false);
  fs.rmSync(dir, { recursive: true });
});

test('B2 run : déduplication par artefact (branche par défaut uniquement, non expiré, pas de fork)', async () => {
  const name = `codex-handoff-pr-7-${HEAD}-code_review`;
  const cases = [
    [[artifact(name)], 'DUPLICATE_HANDOFF'],
    [[artifact(name, { expired: true })], 'CONFIRMED_FINDINGS_HANDOFF_PREPARED'],
    [[artifact(name, { branch: 'claude/demo-fix' })], 'CONFIRMED_FINDINGS_HANDOFF_PREPARED'], // artefact déposé par un workflow de PR
    [[artifact(name, { fork: true })], 'CONFIRMED_FINDINGS_HANDOFF_PREPARED'],
    [[artifact(`codex-handoff-pr-7-${NEW_HEAD}-code_review`)], 'CONFIRMED_FINDINGS_HANDOFF_PREPARED']
  ];
  for (const [artifacts, reason] of cases) {
    const { dir, env } = runEnv();
    const r = await H.run(env, { fetch: fakeGitHub({ artifacts }).fetch, out: () => {} });
    assert.equal(r.reason, reason, JSON.stringify(artifacts));
    fs.rmSync(dir, { recursive: true });
  }
});

test('B2 run : liste des artefacts refusée → UNVERIFIED DEDUP_UNAVAILABLE', async () => {
  const { dir, env } = runEnv();
  const r = await H.run(env, { fetch: fakeGitHub({ artifactsStatus: 403 }).fetch, out: () => {} });
  assert.deepEqual([r.status, r.reason, r.notes], ['UNVERIFIED', 'DEDUP_UNAVAILABLE', ['HTTP_403']]);
  fs.rmSync(dir, { recursive: true });
});

test('B2 run : SHA modifié entre les deux lectures → UNVERIFIED HEAD_SHA_CHANGED', async () => {
  const { dir, env } = runEnv();
  const r = await H.run(env, { fetch: fakeGitHub({ apiAtRecheck: S.findingApi({ sha: NEW_HEAD }) }).fetch, out: () => {} });
  assert.deepEqual([r.status, r.reason, r.currentSha], ['UNVERIFIED', 'HEAD_SHA_CHANGED', NEW_HEAD]);
  fs.rmSync(dir, { recursive: true });
});

test('B2 run : émetteur non Codex → NO_HANDOFF sans aucun appel API', async () => {
  const fake = fakeGitHub();
  const { dir, env } = runEnv({}, S.summaryEvent({ sender: S.OWNER }));
  const r = await H.run(env, { fetch: fake.fetch, out: () => {} });
  assert.deepEqual([r.status, r.reason], ['NO_HANDOFF', 'SENDER_NOT_CODEX']);
  assert.equal(fake.calls.length, 0);
  fs.rmSync(dir, { recursive: true });
});

test('B2 run : lancement manuel — propriétaire accepté, autre acteur refusé', async () => {
  const payload = { inputs: { mode: 'prepare-pr', pr_number: '7' } };
  const ok = runEnv({ GITHUB_ACTOR: 'Anand-Helora' }, payload, 'workflow_dispatch');
  assert.equal((await H.run(ok.env, { fetch: fakeGitHub().fetch, out: () => {} })).status, 'HANDOFF_READY');
  const ko = runEnv({ GITHUB_ACTOR: 'mallory' }, payload, 'workflow_dispatch');
  assert.equal((await H.run(ko.env, { fetch: fakeGitHub().fetch, out: () => {} })).reason, 'ACTOR_NOT_OWNER');
  for (const x of [ok, ko]) fs.rmSync(x.dir, { recursive: true });
});

test('B2 run : contexte manquant → UNVERIFIED ; phase inconnue → UNVERIFIED', async () => {
  const a = runEnv({ GITHUB_TOKEN: '' });
  assert.deepEqual([(await H.run(a.env, { out: () => {} })).reason], ['MISSING_CONTEXT']);
  const b = runEnv({ HANDOFF_PHASE: 'dispatch' });
  assert.deepEqual([(await H.run(b.env, { out: () => {} })).reason], ['UNKNOWN_PHASE']);
  for (const x of [a, b]) fs.rmSync(x.dir, { recursive: true });
});

test('B2 démo hors ligne : tous les scénarios conformes, exemple de dossier, aucun texte hostile', async () => {
  const lines = [];
  const { dir, env, files } = runEnv({ HANDOFF_PHASE: 'demo' });
  const r = await H.run(env, { out: (s) => lines.push(s), fetch: () => { throw new Error('aucun réseau en démo'); } });
  assert.equal(r.ok, true);
  const all = lines.join('\n') + read(files.summary);
  assert.match(all, /HANDOFF_READY/);
  assert.match(all, /NO_HANDOFF/);
  assert.match(all, /UNVERIFIED/);
  assert.match(all, /Exemple de dossier/);
  assertNoHostileText(all);
  fs.rmSync(dir, { recursive: true });
});

// --- Workflow ----------------------------------------------------------------

test('B2 workflow : lecture seule, aucun secret, aucun appel à Claude, interrupteur B1 non activé', () => {
  assert.match(WORKFLOW, /^permissions: \{\}$/m);
  assert.doesNotMatch(WF_CODE, /:\s*write\b/);
  assert.doesNotMatch(WF_CODE, /secrets\./);
  assert.doesNotMatch(WF_CODE, /anthropic|claude-code-action|oauth|@claude/i);
  assert.doesNotMatch(WF_CODE, /CODEX_GATE_ENABLED/);
  assert.doesNotMatch(WF_CODE, /pull_request_target|pull_request_review/);
  for (const p of ['contents: read', 'pull-requests: read', 'issues: read', 'actions: read']) assert.ok(WORKFLOW.includes(p), p);
  assert.match(WORKFLOW, /persist-credentials: false/);
  assert.match(WORKFLOW, /github\.event\.repository\.default_branch/);
  assert.match(WORKFLOW, /github\.event\.sender\.login == 'chatgpt-codex-connector\[bot\]'/);
  assert.match(WORKFLOW, /github\.actor == github\.repository_owner/);
  assert.match(WORKFLOW, /cancel-in-progress: false/);
});

test('B2 workflow : aucune expression ${{ }} interpolée dans une commande', () => {
  const runs = [...WORKFLOW.matchAll(/^\s*run:\s*(.+)$/gm)].map((m) => m[1].trim());
  assert.deepEqual(runs, ['node tools/codex-feedback/handoff.js']);
  assert.match(WORKFLOW, /if: steps\.handoff\.outputs\.handoff == 'true'/);
  assert.match(WORKFLOW, /name: \$\{\{ steps\.handoff\.outputs\.artifact_name \}\}/);
});

test('B2 : les workflows A et B1 restent en place, sans appel à Claude', () => {
  for (const f of ['codex-feedback-dryrun.yml', 'codex-feedback-gate.yml', 'tests.yml']) {
    const wf = fs.readFileSync(path.join(WF_DIR, f), 'utf8');
    assert.doesNotMatch(wf, /anthropic|claude-code-action|secrets\./i, f);
  }
  assert.match(fs.readFileSync(path.join(WF_DIR, 'codex-feedback-gate.yml'), 'utf8'), /vars\.CODEX_GATE_ENABLED == 'true'/);
});

test('B2 : le code de préparation ne contacte aucun service d\'IA', () => {
  for (const f of ['handoff.js', 'handoff-scenarios.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'tools', 'codex-feedback', f), 'utf8');
    assert.doesNotMatch(src, /api\.anthropic\.com|claude\.ai\/api|child_process|\beval\(/, f);
  }
});
