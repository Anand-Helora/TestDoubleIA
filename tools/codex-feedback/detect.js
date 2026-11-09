#!/usr/bin/env node
/*
 * Détecteur « dry run » des anomalies signalées par Codex sur une PR (Issue #5, phase A).
 *
 * LECTURE SEULE : ce script n'écrit rien sur GitHub, n'exécute aucune commande
 * issue d'un commentaire et n'affiche jamais le texte des commentaires.
 * Il produit une décision :
 *   WOULD_REQUEST_CLAUDE_FIX  anomalie Codex confirmée, non résolue, sur le SHA courant
 *   NO_ACTION                 rien à faire (pas d'anomalie, PR fermée, auteur non Codex…)
 *   UNVERIFIED                données incertaines ou incohérentes : aucune action
 *
 * Le contenu de l'événement ne sert qu'à « réveiller » le détecteur et à trouver
 * le numéro de PR : toutes les données utilisées pour décider sont relues via
 * l'API GitHub (requêtes GET et une requête GraphQL de lecture).
 *
 * Usage :
 *   node tools/codex-feedback/detect.js                   (dans GitHub Actions)
 *   node tools/codex-feedback/detect.js --fixture <fichier.json>   (simulation hors ligne)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Identité exacte de Codex, relevée sur la PR #4 (commentaire 6752360596). */
const CODEX = Object.freeze({
  login: 'chatgpt-codex-connector[bot]',
  userId: 199175422,
  appId: 1144995,
  appSlug: 'chatgpt-codex-connector'
});

const DECISION = Object.freeze({
  FIX: 'WOULD_REQUEST_CLAUDE_FIX',
  NONE: 'NO_ACTION',
  UNVERIFIED: 'UNVERIFIED'
});

/** Nombre maximal de cycles « remarques Codex → correction » par PR (phase B). */
const MAX_FIX_CYCLES = 2;

const SHA_RE = /^[0-9a-f]{40}$/;
const STATE_MARKER_RE = /<!--\s*codex-review-state:v1\s+(\{[\s\S]*?\})\s*-->/;
const MAX_STATE_JSON = 4000;
// Badge de priorité des remarques inline Codex : ![P1 Badge](https://img.shields.io/badge/P1-…)
const BADGE_RE = /!\[(P[0-3]) Badge\]\(https:\/\/img\.shields\.io\/badge\/P[0-3]-/;
// Section d'une remarque inline : marqueur observé sur les revues Codex (PR #6).
// Sans marqueur, la remarque est rattachée à code_review (cas des revues de code
// Codex) et une note SECTION_DEFAULTED est ajoutée.
const SECTION_MARKER_RE = /<!--\s*codex-(code|security)-review-finding:v1\s*-->/;
const SUPPORTED_EVENTS = {
  issue_comment: ['created', 'edited'],
  pull_request_review: ['submitted', 'edited'],
  pull_request_review_comment: ['created', 'edited']
};
const REVIEW_SECTIONS = ['code_review', 'security_review'];

// ---------------------------------------------------------------------------
// Identification
// ---------------------------------------------------------------------------

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Vrai seulement pour le compte bot Codex : login, identifiant numérique ET type. */
function isCodexUser(user) {
  return isObject(user) && user.login === CODEX.login && user.id === CODEX.userId && user.type === 'Bot';
}

/** Si l'API indique l'application à l'origine du contenu, elle doit être Codex. */
function isCodexApp(app) {
  if (app === undefined || app === null) return true; // champ absent sur certains objets (reviews)
  return isObject(app) && app.id === CODEX.appId && app.slug === CODEX.appSlug;
}

function isCodexAuthored(item) {
  return isObject(item) && isCodexUser(item.user) && isCodexApp(item.performed_via_github_app);
}

// ---------------------------------------------------------------------------
// Lecture de l'événement déclencheur (non fiable : sert uniquement de réveil)
// ---------------------------------------------------------------------------

/**
 * Retourne { prNumber, eventName, action, manual } ou { stop: résultat partiel }.
 */
function readTrigger(eventName, payload) {
  if (!isObject(payload)) return { stop: { decision: DECISION.UNVERIFIED, reason: 'MALFORMED_PAYLOAD' } };

  if (eventName === 'workflow_dispatch') {
    const raw = isObject(payload.inputs) ? payload.inputs.pr_number : undefined;
    if (typeof raw !== 'string' || !/^[1-9][0-9]{0,9}$/.test(raw)) {
      return { stop: { decision: DECISION.UNVERIFIED, reason: 'MALFORMED_PAYLOAD' } };
    }
    return { prNumber: Number(raw), eventName, action: 'manual', manual: true };
  }

  const actions = SUPPORTED_EVENTS[eventName];
  if (!actions) return { stop: { decision: DECISION.NONE, reason: 'UNSUPPORTED_EVENT' } };
  if (!actions.includes(payload.action)) return { stop: { decision: DECISION.NONE, reason: 'UNSUPPORTED_ACTION' } };

  let pr; let author;
  if (eventName === 'issue_comment') {
    if (!isObject(payload.issue) || !isObject(payload.comment)) {
      return { stop: { decision: DECISION.UNVERIFIED, reason: 'MALFORMED_PAYLOAD' } };
    }
    if (!isObject(payload.issue.pull_request)) return { stop: { decision: DECISION.NONE, reason: 'NOT_A_PULL_REQUEST' } };
    pr = payload.issue.number;
    author = payload.comment;
  } else {
    const item = eventName === 'pull_request_review' ? payload.review : payload.comment;
    if (!isObject(payload.pull_request) || !isObject(item)) {
      return { stop: { decision: DECISION.UNVERIFIED, reason: 'MALFORMED_PAYLOAD' } };
    }
    pr = payload.pull_request.number;
    author = item;
  }
  if (!Number.isSafeInteger(pr) || pr < 1) return { stop: { decision: DECISION.UNVERIFIED, reason: 'MALFORMED_PAYLOAD' } };

  // Filtre d'auteur : un commentaire tiers (même contenant « @codex » ou imitant
  // le format du résumé) ne déclenche jamais d'analyse ni d'appel API.
  if (!isCodexAuthored(author)) {
    return { stop: { decision: DECISION.NONE, reason: 'TRIGGER_NOT_FROM_CODEX', prNumber: pr } };
  }
  return { prNumber: pr, eventName, action: payload.action, manual: false };
}

// ---------------------------------------------------------------------------
// Analyse des données relues via l'API
// ---------------------------------------------------------------------------

/** Extrait l'état machine du résumé Codex. null si absent, { error } si illisible. */
function parseReviewState(body) {
  if (typeof body !== 'string') return null;
  const m = STATE_MARKER_RE.exec(body);
  if (!m) return null;
  if (m[1].length > MAX_STATE_JSON) return { error: 'STATE_TOO_LARGE' };
  let data;
  try { data = JSON.parse(m[1]); } catch (e) { return { error: 'STATE_NOT_JSON' }; }
  if (!isObject(data)) return { error: 'STATE_INVALID' };
  const sections = {};
  for (const name of REVIEW_SECTIONS) {
    const s = data[name];
    if (s === undefined || s === null) continue;
    if (!isObject(s)) return { error: 'STATE_INVALID' };
    const sha = s.commit_sha;
    const okSha = sha === null || (typeof sha === 'string' && SHA_RE.test(sha));
    const okStatus = s.status === null || typeof s.status === 'string';
    const okFlag = (v) => v === null || v === undefined || typeof v === 'boolean';
    if (!okSha || !okStatus || !okFlag(s.has_unresolved_findings) || !okFlag(s.has_any_findings)) {
      return { error: 'STATE_INVALID' };
    }
    if (sha === null) continue; // section jamais exécutée
    sections[name] = { commitSha: sha, status: s.status, unresolved: s.has_unresolved_findings, any: s.has_any_findings };
  }
  return { sections };
}

function safeUrl(url, repo) {
  const prefix = `https://github.com/${repo}/`;
  return typeof url === 'string' && url.startsWith(prefix) && !/[\s<>"'`]/.test(url) ? url : null;
}

/**
 * Clé d'idempotence : PR + SHA courant + sections de revue ayant une anomalie.
 *
 * Une même observation peut apparaître d'abord comme remarque inline, puis
 * dans le résumé final (ou l'inverse) : elle est identifiée par sa section
 * (code_review / security_review), pas par le signal qui la porte, ni par le
 * texte, ni par la date. La clé reste donc stable quel que soit l'ordre
 * d'arrivée des signaux et les éditions. Compromis : deux remarques de la même
 * section sur le même SHA partagent la clé, ce qui correspond à la règle
 * « au plus un cycle de correction par SHA ».
 */
function idempotencyKey(prNumber, headSha, sections) {
  const canonical = [...new Set(sections)].sort().join('+');
  return `codex-fix:pr-${prNumber}:${headSha}:${canonical}`;
}

/**
 * Normalise un identifiant de commentaire en chaîne décimale canonique, sans perte
 * de précision. Les identifiants GitHub dépassent l'Int GraphQL 32 bits
 * (ex. 4518670008) : côté GraphQL on lit fullDatabaseId (BigInt, sérialisé en
 * chaîne), côté REST un nombre JSON. Retourne null si la valeur est invalide ou
 * hors de la plage des entiers JavaScript sûrs (correspondance non fiable).
 */
function normalizeId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value)) return null;
  return Number.isSafeInteger(Number(value)) ? value : null;
}

/** Marque d'un identifiant de fil présent plusieurs fois (correspondance ambiguë). */
const AMBIGUOUS = Object.freeze({ ambiguous: true });

function sectionOf(body) {
  const m = typeof body === 'string' ? SECTION_MARKER_RE.exec(body) : null;
  return m ? { section: `${m[1]}_review`, defaulted: false } : { section: 'code_review', defaulted: true };
}

/**
 * Décision à partir des données API (fonction pure).
 * @param trigger  résultat de readTrigger (sans `stop`)
 * @param api      { repo, pr, issueComments, reviews, reviewComments, threads }
 *                 threads : objet { idCommentaireRacine: { isResolved, isOutdated } } ou null si indisponible
 * @param options  { seenKeys: Set } clés déjà traitées (stockage prévu en phase B ; vide en phase A)
 */
function analyze(trigger, api, options = {}) {
  const seenKeys = options.seenKeys instanceof Set ? options.seenKeys : new Set();
  const base = { prNumber: trigger.prNumber, trigger: { event: trigger.eventName, action: trigger.action } };
  const result = (decision, reason, extra = {}) => ({ ...base, decision, reason, ...extra });

  if (!isObject(api) || !isObject(api.pr) || !Array.isArray(api.issueComments) ||
      !Array.isArray(api.reviews) || !Array.isArray(api.reviewComments)) {
    return result(DECISION.UNVERIFIED, 'API_DATA_INVALID');
  }
  const { pr, repo } = api;
  if (pr.number !== trigger.prNumber || typeof pr.state !== 'string' || !isObject(pr.head) ||
      typeof pr.head.sha !== 'string' || !SHA_RE.test(pr.head.sha)) {
    return result(DECISION.UNVERIFIED, 'API_DATA_INVALID');
  }
  const headSha = pr.head.sha;
  if (pr.state !== 'open') return result(DECISION.NONE, 'PR_NOT_OPEN', { headSha });

  const notes = [];

  // 1. Résumé Codex (commentaire de conversation) : le plus récent fait foi.
  const summaries = api.issueComments
    .filter((c) => isCodexAuthored(c) && typeof c.body === 'string' && STATE_MARKER_RE.test(c.body))
    .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)) || a.id - b.id);
  const summary = summaries.length ? summaries[summaries.length - 1] : null;
  const state = summary ? parseReviewState(summary.body) : null;
  if (state && state.error) {
    return result(DECISION.UNVERIFIED, 'SUMMARY_STATE_UNREADABLE', { headSha, notes: [state.error] });
  }
  const sections = state ? state.sections : {};
  const headSections = Object.entries(sections).filter(([, s]) => s.commitSha === headSha);
  const staleSections = Object.entries(sections).filter(([, s]) => s.commitSha !== headSha);

  // 2. Reviews et remarques inline de Codex.
  const codexReviews = api.reviews.filter((r) => isCodexAuthored(r) && typeof r.commit_id === 'string');
  const reviewCommit = new Map(codexReviews.map((r) => [r.id, r.commit_id]));
  const inline = api.reviewComments
    .filter((c) => isCodexAuthored(c) && !c.in_reply_to_id)
    .map((c) => {
      const commit = reviewCommit.get(c.pull_request_review_id) || c.original_commit_id || null;
      const badge = typeof c.body === 'string' ? BADGE_RE.exec(c.body) : null;
      const key = normalizeId(c.id);
      const entry = api.threads && key !== null && Object.prototype.hasOwnProperty.call(api.threads, key)
        ? api.threads[key] : null;
      // Fil introuvable, ambigu ou mal formé → statut inconnu (UNVERIFIED si rien d'autre ne confirme).
      const thread = isObject(entry) && !entry.ambiguous &&
        typeof entry.isResolved === 'boolean' && typeof entry.isOutdated === 'boolean' ? entry : null;
      const { section, defaulted } = sectionOf(c.body);
      return {
        id: c.id,
        commit,
        section,
        sectionDefaulted: defaulted,
        priority: badge ? badge[1] : null,
        resolved: thread ? thread.isResolved === true : null,
        outdated: thread ? thread.isOutdated === true : null,
        url: safeUrl(c.html_url, repo)
      };
    });
  const inlineOnHead = inline.filter((c) => c.commit === headSha);
  const reviewsOnHead = codexReviews.filter((r) => r.commit_id === headSha);

  // Remarques inline sur le SHA courant
  const confirmedInline = inlineOnHead.filter((c) => c.priority && c.resolved === false && c.outdated === false);
  const resolvedInline = inlineOnHead.filter((c) => c.resolved === true || c.outdated === true);
  const unknownInline = inlineOnHead.filter((c) => !c.priority || c.resolved === null);
  if (api.threads === null && inlineOnHead.length) notes.push('THREAD_STATUS_UNAVAILABLE');
  if (api.threads && inlineOnHead.some((c) => c.resolved === null)) notes.push('THREAD_NOT_MATCHED');
  if (inlineOnHead.some((c) => c.sectionDefaulted)) notes.push('SECTION_DEFAULTED');

  // Résumé sur le SHA courant
  const pending = headSections.filter(([, s]) => s.status !== 'completed');
  const summaryUnresolved = headSections.filter(([, s]) => s.status === 'completed' && s.unresolved === true);
  const summaryClean = headSections.length > 0 && pending.length === 0 && summaryUnresolved.length === 0 &&
    headSections.every(([, s]) => s.unresolved === false);

  const findings = [
    ...confirmedInline.map((c) => ({ source: 'inline', section: c.section, id: `inline:${c.id}`, priority: c.priority, url: c.url })),
    ...summaryUnresolved.map(([name]) => ({
      source: `summary/${name}`, section: name, id: `summary:${summary.id}:${name}`, priority: null,
      url: safeUrl(summary.html_url, repo)
    }))
  ];
  const commonExtra = { headSha, reviewedOnHead: headSections.length > 0 || reviewsOnHead.length > 0 };

  // Contradictions entre les sources de Codex → incertain. Elles ne sont
  // évaluées qu'à l'intérieur d'une même section : des fils résolus de
  // code_review ne disent rien d'une anomalie signalée par security_review.
  const contradictions = [];
  for (const [name, s] of headSections) {
    if (s.status !== 'completed') continue;
    const sectionInline = inlineOnHead.filter((c) => c.section === name);
    const confirmed = sectionInline.filter((c) => confirmedInline.includes(c));
    const unknown = sectionInline.filter((c) => unknownInline.includes(c));
    if (s.unresolved === false && confirmed.length) contradictions.push(`${name}:SUMMARY_CLEAN_THREAD_UNRESOLVED`);
    if (s.unresolved === true && sectionInline.length && !confirmed.length && !unknown.length) {
      contradictions.push(`${name}:SUMMARY_UNRESOLVED_THREADS_RESOLVED`);
    }
  }
  if (contradictions.length) {
    return result(DECISION.UNVERIFIED, 'CONTRADICTORY_SIGNALS', { ...commonExtra, findings, notes: [...notes, ...contradictions] });
  }

  if (findings.length) {
    const key = idempotencyKey(trigger.prNumber, headSha, findings.map((f) => f.section));
    // Cycles : SHA distincts sur lesquels Codex a laissé des remarques classées, plus le SHA courant.
    const previous = new Set(inline.filter((c) => c.priority && c.commit && c.commit !== headSha).map((c) => c.commit));
    const cycle = previous.size + 1;
    const extra = { ...commonExtra, findings, notes, idempotencyKey: key, cycle, maxCycles: MAX_FIX_CYCLES };
    if (seenKeys.has(key)) return result(DECISION.NONE, 'DUPLICATE_ALREADY_REPORTED', extra);
    if (cycle > MAX_FIX_CYCLES) return result(DECISION.NONE, 'CYCLE_LIMIT_REACHED', extra);
    return result(DECISION.FIX, 'CONFIRMED_UNRESOLVED_FINDINGS_ON_HEAD', extra);
  }

  if (unknownInline.length) {
    return result(DECISION.UNVERIFIED, 'FINDING_STATUS_UNKNOWN', { ...commonExtra, notes });
  }
  if (pending.length) return result(DECISION.UNVERIFIED, 'REVIEW_IN_PROGRESS', { ...commonExtra, notes });
  if (headSections.length && !summaryClean) {
    // Résumé terminé sur le SHA courant mais sans indicateur exploitable (null…).
    return result(DECISION.UNVERIFIED, 'SUMMARY_AMBIGUOUS', { ...commonExtra, notes });
  }
  if (resolvedInline.length) return result(DECISION.NONE, 'FINDINGS_RESOLVED', { ...commonExtra, notes });
  if (summaryClean || reviewsOnHead.length) return result(DECISION.NONE, 'NO_FINDINGS_ON_HEAD', { ...commonExtra, notes });
  if (staleSections.length || inline.length || codexReviews.length) {
    return result(DECISION.NONE, 'REVIEW_ON_STALE_SHA', { ...commonExtra, notes });
  }
  return result(DECISION.NONE, 'NO_CODEX_REVIEW', { ...commonExtra, notes });
}

/** Point d'entrée pur : événement + données API → décision. */
function evaluate(eventName, payload, api, options) {
  const trigger = readTrigger(eventName, payload);
  if (trigger.stop) {
    return { prNumber: trigger.stop.prNumber || null, trigger: { event: eventName, action: isObject(payload) ? payload.action : null },
      decision: trigger.stop.decision, reason: trigger.stop.reason };
  }
  return analyze(trigger, api, options);
}

// ---------------------------------------------------------------------------
// Sortie (journal, résumé de l'exécution) : jamais de texte de commentaire
// ---------------------------------------------------------------------------

/** Neutralise les séquences de commandes de workflow (::) et sauts de ligne. */
function clean(v) {
  return String(v).replace(/[\r\n%]/g, ' ').replace(/::/g, ': :');
}

function renderSummary(r) {
  const lines = [
    '## Codex feedback — dry run',
    '',
    '| Champ | Valeur |',
    '| --- | --- |',
    `| Décision | **${clean(r.decision)}** |`,
    `| Raison | \`${clean(r.reason)}\` |`,
    `| PR | ${r.prNumber ? '#' + clean(r.prNumber) : '—'} |`,
    `| SHA courant | ${r.headSha ? '`' + clean(r.headSha) + '`' : '—'} |`,
    `| Événement | ${clean(r.trigger && r.trigger.event)} / ${clean(r.trigger && r.trigger.action)} |`
  ];
  if (r.idempotencyKey) lines.push(`| Clé d'idempotence | \`${clean(r.idempotencyKey)}\` |`);
  if (r.cycle) lines.push(`| Cycle | ${clean(r.cycle)} / ${clean(r.maxCycles)} |`);
  if (r.notes && r.notes.length) lines.push(`| Notes | ${r.notes.map(clean).join(', ')} |`);
  if (r.findings && r.findings.length) {
    lines.push('', '### Remarques Codex retenues', '', '| Source | Section | Priorité | Lien |', '| --- | --- | --- | --- |');
    for (const f of r.findings) {
      lines.push(`| ${clean(f.source)} | ${clean(f.section)} | ${clean(f.priority || '—')} | ${f.url ? `[ouvrir](${f.url})` : '—'} |`);
    }
  }
  lines.push('', '_Mode lecture seule : aucune action effectuée._', '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Accès API GitHub (lecture seule)
// ---------------------------------------------------------------------------

async function ghGet(url, ctx) {
  const res = await ctx.fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${ctx.token}`, 'X-GitHub-Api-Version': '2022-11-28' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url.replace(/\?.*/, '')}`);
  return res;
}

async function ghList(pathname, ctx, maxPages = 10) {
  let url = `${ctx.apiUrl}${pathname}${pathname.includes('?') ? '&' : '?'}per_page=100`;
  const items = [];
  for (let page = 0; url && page < maxPages; page++) {
    const res = await ghGet(url, ctx);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('réponse non paginée inattendue');
    items.push(...data);
    const link = res.headers.get('link') || '';
    const next = /<([^>]+)>;\s*rel="next"/.exec(link);
    url = next ? next[1] : null;
  }
  if (url) throw new Error('pagination tronquée'); // données incomplètes → incertain
  return items;
}

/**
 * Statut des fils de discussion (résolu / obsolète) : uniquement disponible en GraphQL.
 * Le commentaire racine est identifié par fullDatabaseId (BigInt) et non par
 * databaseId (Int 32 bits, insuffisant pour les identifiants actuels de GitHub).
 * Retourne { idCanonique: { isResolved, isOutdated } } ou null si indisponible.
 */
async function fetchThreads(owner, name, number, ctx) {
  const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
    reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved isOutdated comments(first:1){nodes{fullDatabaseId}}}}}}}`;
  const res = await ctx.fetch(ctx.graphqlUrl, {
    method: 'POST', // requête GraphQL de lecture (query), aucune mutation
    headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { owner, name, number } })
  });
  if (!res.ok) return null;
  const data = await res.json();
  // Toute erreur GraphQL (même partielle) rend la réponse non fiable.
  if (!isObject(data) || (Array.isArray(data.errors) && data.errors.length)) return null;
  const threads = data.data && data.data.repository && data.data.repository.pullRequest &&
    data.data.repository.pullRequest.reviewThreads;
  if (!isObject(threads) || !isObject(threads.pageInfo) || threads.pageInfo.hasNextPage !== false ||
      !Array.isArray(threads.nodes)) return null;
  return buildThreadMap(threads.nodes);
}

/** Construit la table des fils à partir des nœuds GraphQL (fonction pure, testée). */
function buildThreadMap(nodes) {
  const map = {};
  for (const t of nodes) {
    const root = isObject(t) && isObject(t.comments) && Array.isArray(t.comments.nodes) ? t.comments.nodes[0] : null;
    const key = isObject(root) ? normalizeId(root.fullDatabaseId) : null;
    if (key === null || typeof t.isResolved !== 'boolean' || typeof t.isOutdated !== 'boolean') continue;
    map[key] = Object.prototype.hasOwnProperty.call(map, key) ? AMBIGUOUS : { isResolved: t.isResolved, isOutdated: t.isOutdated };
  }
  return map;
}

async function fetchApiData(prNumber, ctx) {
  const [owner, name] = ctx.repo.split('/');
  const base = `/repos/${owner}/${name}`;
  const pr = await (await ghGet(`${ctx.apiUrl}${base}/pulls/${prNumber}`, ctx)).json();
  const [issueComments, reviews, reviewComments] = await Promise.all([
    ghList(`${base}/issues/${prNumber}/comments`, ctx),
    ghList(`${base}/pulls/${prNumber}/reviews`, ctx),
    ghList(`${base}/pulls/${prNumber}/comments`, ctx)
  ]);
  let threads = null;
  try { threads = await fetchThreads(owner, name, prNumber, ctx); } catch (e) { threads = null; }
  return { repo: ctx.repo, pr, issueComments, reviews, reviewComments, threads };
}

// ---------------------------------------------------------------------------
// Exécution
// ---------------------------------------------------------------------------

/** Charge un scénario de simulation (tests/fixtures/codex/<nom>.json). */
function loadFixture(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    eventName: data.eventName,
    payload: data.payload,
    api: data.api,
    seenKeys: new Set(data.seenKeys || []),
    expected: data.expected
  };
}

const FIXTURE_DIR = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'codex');

/** Nom de scénario (entrée workflow_dispatch) → chemin, uniquement dans le dossier des fixtures. */
function fixturePath(name) {
  if (typeof name !== 'string' || !/^[a-z0-9-]{1,64}$/.test(name)) throw new Error('nom de scénario invalide');
  const file = path.join(FIXTURE_DIR, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error('scénario inconnu');
  return file;
}

async function run(env, deps = {}) {
  const out = deps.out || ((s) => process.stdout.write(s + '\n'));
  let result;
  if (env.FIXTURE_NAME && env.FIXTURE_NAME !== 'none' && !env.FIXTURE_FILE) {
    env = { ...env, FIXTURE_FILE: fixturePath(env.FIXTURE_NAME) };
  }

  if (env.FIXTURE_FILE) {
    const fx = loadFixture(env.FIXTURE_FILE);
    result = evaluate(fx.eventName, fx.payload, fx.api, { seenKeys: fx.seenKeys });
    result.fixture = path.basename(env.FIXTURE_FILE, '.json');
  } else {
    const eventName = env.GITHUB_EVENT_NAME;
    let payload = null;
    try { payload = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')); } catch (e) { payload = null; }
    const trigger = readTrigger(eventName, payload);
    if (trigger.stop) {
      result = evaluate(eventName, payload, null);
    } else if (!env.GITHUB_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY || '')) {
      result = { prNumber: trigger.prNumber, trigger: { event: eventName, action: trigger.action },
        decision: DECISION.UNVERIFIED, reason: 'MISSING_CONTEXT' };
    } else {
      const ctx = {
        repo: env.GITHUB_REPOSITORY,
        token: env.GITHUB_TOKEN,
        apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
        graphqlUrl: env.GITHUB_GRAPHQL_URL || 'https://api.github.com/graphql',
        fetch: deps.fetch || globalThis.fetch
      };
      try {
        const api = await fetchApiData(trigger.prNumber, ctx);
        // Phase A : aucun stockage persistant des clés déjà traitées (voir documentation).
        result = analyze(trigger, api, { seenKeys: new Set() });
      } catch (e) {
        result = { prNumber: trigger.prNumber, trigger: { event: eventName, action: trigger.action },
          decision: DECISION.UNVERIFIED, reason: 'API_ERROR', notes: [clean(e.message).slice(0, 200)] };
      }
    }
  }

  const summary = renderSummary(result);
  out(`::notice title=Codex feedback (dry run)::${clean(result.decision)} — ${clean(result.reason)}` +
      (result.prNumber ? ` — PR #${clean(result.prNumber)}` : ''));
  out(JSON.stringify(result));
  const write = deps.appendFile || fs.appendFileSync;
  if (env.GITHUB_STEP_SUMMARY) write(env.GITHUB_STEP_SUMMARY, summary + '\n');
  if (env.GITHUB_OUTPUT) {
    write(env.GITHUB_OUTPUT, `decision=${clean(result.decision)}\nreason=${clean(result.reason)}\n` +
      `idempotency_key=${clean(result.idempotencyKey || '')}\n`);
  }
  return result;
}

module.exports = {
  CODEX, DECISION, MAX_FIX_CYCLES,
  isCodexUser, isCodexAuthored, readTrigger, parseReviewState, analyze, evaluate,
  renderSummary, clean, idempotencyKey, fetchApiData, fetchThreads, buildThreadMap, normalizeId, loadFixture, fixturePath, run
};

if (require.main === module) {
  const env = { ...process.env };
  const i = process.argv.indexOf('--fixture');
  if (i !== -1) env.FIXTURE_FILE = process.argv[i + 1];
  run(env).catch((e) => {
    process.stdout.write(`::error title=Codex feedback (dry run)::erreur interne ${clean(e && e.message)}\n`);
    process.exitCode = 1;
  });
}
