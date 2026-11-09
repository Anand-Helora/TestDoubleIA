// Tests de l'interface (game.js) avec un DOM et des minuteurs simulés.
// Exécute le vrai game.js dans un contexte vm isolé. Lancement : node --test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SNAKE_SRC = fs.readFileSync(path.join(ROOT, 'snake.js'), 'utf8');
const BEST_SRC = fs.readFileSync(path.join(ROOT, 'best-score.js'), 'utf8');
const GAME_SRC = fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8');

function fakeElement(extra = {}) {
  const listeners = {};
  return Object.assign({
    textContent: '',
    hidden: false,
    width: 400,
    height: 400,
    listeners,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    focus() { doc.activeElement = this; },
    getContext() {
      return new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
    }
  }, extra);
}

let doc;

/** Charge la page simulée et renvoie des outils de pilotage. */
// `setupWindow(window)` permet de définir window.localStorage (ou un accès qui lève).
function loadGame({ search = '?test', random = () => 0, setupWindow = null } = {}) {
  const els = {
    board: fakeElement(), score: fakeElement(), best: fakeElement(), message: fakeElement(),
    overlay: fakeElement(), 'overlay-title': fakeElement(), restart: fakeElement()
  };
  const docListeners = {};
  doc = {
    hidden: false,
    activeElement: null,
    getElementById: (id) => els[id],
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); }
  };

  // Minuteurs contrôlés manuellement
  const timers = new Map();
  let nextId = 1;
  const clock = {
    setInterval(fn, ms) { const id = nextId++; timers.set(id, { fn, ms, acc: 0 }); return id; },
    clearInterval(id) { timers.delete(id); },
    advance(ms) {
      for (let t = 0; t < ms; t++) {
        for (const timer of [...timers.values()]) {
          if (++timer.acc >= timer.ms) { timer.acc = 0; timer.fn(); }
        }
      }
    },
    count: () => timers.size
  };

  const window = { location: { search } };
  if (setupWindow) setupWindow(window);
  const sandbox = {
    document: doc, window, self: window,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    Math: Object.assign(Object.create(Math), { random })
  };
  vm.createContext(sandbox);
  vm.runInContext(SNAKE_SRC, sandbox);
  sandbox.SnakeLogic = sandbox.self.SnakeLogic;
  vm.runInContext(BEST_SRC, sandbox);
  sandbox.BestScore = sandbox.self.BestScore;
  vm.runInContext(GAME_SRC, sandbox);

  function key(k, opts = {}) {
    const ev = { key: k, repeat: false, ctrlKey: false, metaKey: false, altKey: false,
      defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...opts };
    for (const fn of docListeners.keydown || []) fn(ev);
    return ev;
  }
  function setHidden(h) {
    doc.hidden = h;
    for (const fn of docListeners.visibilitychange || []) fn();
  }

  return { els, clock, key, setHidden, window, api: window.__snake };
}

const head = (g) => ({ ...g.api.getState().snake[0] });

test('maintenir Espace (keydown répétés) ne relance pas la partie en pause', () => {
  const g = loadGame();
  g.key('ArrowUp');
  g.clock.advance(120);
  g.key(' ');                              // pause
  assert.equal(g.clock.count(), 0);
  const frozen = head(g);
  for (let i = 0; i < 25; i++) {           // ~1 s de répétition clavier
    const ev = g.key(' ', { repeat: true });
    assert.equal(ev.defaultPrevented, true, 'défilement de page empêché');
    g.clock.advance(40);
  }
  assert.equal(g.clock.count(), 0, 'aucun minuteur relancé');
  assert.deepEqual(head(g), frozen, 'aucun déplacement pendant le maintien');
  assert.match(g.els.message.textContent, /Pause/);

  g.key(' ');                              // nouvelle pression distincte → reprise
  assert.equal(g.clock.count(), 1);
  g.clock.advance(120);
  assert.notDeepEqual(head(g), frozen);
});

test('maintenir Espace pendant le jeu ne fait pas alterner pause/reprise', () => {
  const g = loadGame();
  g.key('ArrowUp');
  g.key(' ');
  for (let i = 0; i < 10; i++) {
    g.key(' ', { repeat: true });
    assert.equal(g.clock.count(), 0, `reste en pause après la répétition ${i + 1}`);
  }
});

test('maintenir Entrée en fin de partie ne relance qu\'une seule partie', () => {
  const g = loadGame();
  g.key('ArrowUp');
  g.clock.advance(120 * 15);               // atteint le mur du haut
  assert.equal(g.api.getState().status, 'over');
  assert.equal(g.els.overlay.hidden, false);
  assert.equal(g.els['overlay-title'].textContent, 'Partie terminée');

  doc.activeElement = null;
  g.key('Enter', { repeat: true });        // répétition seule : ignorée
  assert.equal(g.api.getState().status, 'over');
  g.key('Enter');
  assert.equal(g.api.getState().status, 'playing');
  assert.equal(g.els.overlay.hidden, true);
  assert.equal(g.els.score.textContent, '0');
});

test('30 redémarrages successifs : un seul minuteur et vitesse constante', () => {
  const g = loadGame();
  for (let i = 0; i < 30; i++) {
    g.api.restart();
    g.key('ArrowDown');
    g.clock.advance(60);
    assert.ok(g.clock.count() <= 1);
  }
  const y0 = head(g).y;
  g.clock.advance(600);
  assert.equal(head(g).y - y0, 5, '5 pas en 600 ms à 120 ms/pas');
  assert.equal(g.clock.count(), 1);
});

test('onglet masqué : pause, puis reste en pause au retour', () => {
  const g = loadGame();
  g.key('ArrowUp');
  g.setHidden(true);
  assert.equal(g.clock.count(), 0);
  g.setHidden(false);
  assert.equal(g.clock.count(), 0);
  assert.match(g.els.message.textContent, /Pause/);
});

test('window.__snake absent hors mode test, présent avec ?test', () => {
  assert.equal(loadGame({ search: '' }).api, undefined);
  assert.equal(loadGame({ search: '?foo=1' }).api, undefined);
  assert.equal(loadGame({ search: '?testing' }).api, undefined);
  assert.ok(loadGame({ search: '?test' }).api);
  assert.ok(loadGame({ search: '?a=1&test=1' }).api);
});

// --- Meilleur score (Issue #3) ---

const BEST_KEY = 'snake.bestScore';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); }
  };
}

/** Fait manger `n` pommes : la pomme est placée devant la tête avant chaque pas. */
function eatApples(g, n) {
  for (let i = 0; i < n; i++) {
    const s = g.api.getState();
    s.food = { x: s.snake[0].x, y: s.snake[0].y - 1 };
    g.clock.advance(120);
  }
}

/** Démarre vers le haut depuis le centre (10,10) ; la pomme (0,0) reste hors trajet. */
function startUp(g) {
  g.api.getState().food = { x: 0, y: 0 };
  g.key('ArrowUp');
}

test('record affiché à côté du score : 0 au premier lancement', () => {
  const storage = memoryStorage();
  const g = loadGame({ setupWindow: (w) => { w.localStorage = storage; } });
  assert.equal(g.els.best.textContent, '0');
  assert.equal(g.els.score.textContent, '0');
});

test('record relu depuis localStorage à l\'initialisation', () => {
  const storage = memoryStorage({ [BEST_KEY]: '17' });
  const g = loadGame({ setupWindow: (w) => { w.localStorage = storage; } });
  assert.equal(g.els.best.textContent, '17');
});

test('record mis à jour immédiatement dès qu\'il est dépassé, et enregistré', () => {
  const storage = memoryStorage({ [BEST_KEY]: '2' });
  const g = loadGame({ setupWindow: (w) => { w.localStorage = storage; } });
  startUp(g);
  eatApples(g, 2);
  assert.equal(g.els.score.textContent, '2');
  assert.equal(g.els.best.textContent, '2', 'égalité : record inchangé');
  assert.equal(storage.data[BEST_KEY], '2');
  eatApples(g, 1);
  assert.equal(g.els.score.textContent, '3');
  assert.equal(g.els.best.textContent, '3', 'dépassé : affichage immédiat, avant la fin de partie');
  assert.equal(storage.data[BEST_KEY], '3', 'enregistré sans attendre la fin de partie');
  assert.equal(g.api.getState().status, 'playing');
});

test('le record survit au redémarrage et à une nouvelle session', () => {
  const storage = memoryStorage();
  const setupWindow = (w) => { w.localStorage = storage; };
  const g = loadGame({ setupWindow });
  startUp(g);
  eatApples(g, 4);
  g.api.restart();
  assert.equal(g.els.score.textContent, '0');
  assert.equal(g.els.best.textContent, '4', 'conservé après « Recommencer »');
  startUp(g);
  eatApples(g, 1);
  assert.equal(g.els.best.textContent, '4', 'un score plus faible ne remplace pas le record');

  const g2 = loadGame({ setupWindow }); // rechargement de la page
  assert.equal(g2.els.best.textContent, '4');
});

test('« Nouveau record ! » en fin de partie seulement si le record a été battu', () => {
  const storage = memoryStorage({ [BEST_KEY]: '1' });
  const g = loadGame({ setupWindow: (w) => { w.localStorage = storage; } });
  startUp(g);
  eatApples(g, 2);
  g.clock.advance(120 * 20); // mur du haut
  assert.equal(g.api.getState().status, 'over');
  assert.match(g.els.message.textContent, /Score final : 2\. Nouveau record !/);

  g.api.restart();
  startUp(g);
  eatApples(g, 1);
  g.clock.advance(120 * 20);
  assert.equal(g.api.getState().status, 'over');
  assert.doesNotMatch(g.els.message.textContent, /Nouveau record/);
});

test('localStorage absent : jeu jouable, record en mémoire', () => {
  const g = loadGame(); // aucune propriété localStorage
  assert.equal(g.els.best.textContent, '0');
  startUp(g);
  eatApples(g, 2);
  assert.equal(g.els.best.textContent, '2');
  g.clock.advance(120 * 20);
  assert.equal(g.api.getState().status, 'over');
  g.api.restart();
  assert.equal(g.els.best.textContent, '2');
});

test('accès à localStorage bloqué (SecurityError) : le jeu démarre et reste jouable', () => {
  const g = loadGame({
    setupWindow: (w) => {
      Object.defineProperty(w, 'localStorage', { get() { throw new Error('SecurityError'); } });
    }
  });
  assert.equal(g.els.best.textContent, '0');
  startUp(g);
  eatApples(g, 1);
  assert.equal(g.els.score.textContent, '1');
  assert.equal(g.els.best.textContent, '1');
});

test('getItem et setItem qui lèvent : aucune erreur, record en mémoire', () => {
  const storage = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceededError'); }
  };
  const g = loadGame({ setupWindow: (w) => { w.localStorage = storage; } });
  assert.equal(g.els.best.textContent, '0');
  startUp(g);
  assert.doesNotThrow(() => eatApples(g, 3));
  assert.equal(g.els.best.textContent, '3');
  assert.equal(g.api.getState().status, 'playing');
});

test('valeurs corrompues ou négatives dans localStorage : record 0', () => {
  for (const raw of ['-8', 'abc', '2.5', 'Infinity', '1e9', '']) {
    const storage = memoryStorage({ [BEST_KEY]: raw });
    const g = loadGame({ setupWindow: (w) => { w.localStorage = storage; } });
    assert.equal(g.els.best.textContent, '0', raw);
    startUp(g);
    eatApples(g, 1);
    assert.equal(storage.data[BEST_KEY], '1', `${raw} remplacé par un record valide`);
  }
});
