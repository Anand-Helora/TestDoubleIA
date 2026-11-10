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
    overlay: fakeElement(), 'overlay-title': fakeElement(),
    restart: fakeElement({ tagName: 'BUTTON', disabled: false }),
    pause: fakeElement({ tagName: 'BUTTON', disabled: true, textContent: 'Pause' }),
    'pause-hint': fakeElement(),
    'dir-up': fakeElement({ tagName: 'BUTTON', disabled: false }),
    'dir-down': fakeElement({ tagName: 'BUTTON', disabled: false }),
    'dir-left': fakeElement({ tagName: 'BUTTON', disabled: false }),
    'dir-right': fakeElement({ tagName: 'BUTTON', disabled: false })
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

  /** Clic (souris, tactile ou activation native au clavier) : ignoré si le bouton est désactivé. */
  function click(el) {
    if (el.disabled) return false;
    for (const fn of el.listeners.click || []) fn({ type: 'click', target: el });
    return true;
  }

  return { els, clock, key, click, setHidden, window, api: window.__snake };
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

// --- Bouton Pause / Reprendre (Issue #7) ---

/** État visible du bouton */
const btn = (g) => ({ disabled: g.els.pause.disabled, label: g.els.pause.textContent });

test('bouton Pause : désactivé avant le démarrage, avec une explication', () => {
  const g = loadGame();
  assert.deepEqual(btn(g), { disabled: true, label: 'Pause' });
  assert.match(g.els['pause-hint'].textContent, /partie commencée/);
  assert.equal(g.click(g.els.pause), false);
  assert.equal(g.clock.count(), 0, 'aucun minuteur lancé par le bouton');
});

test('bouton Pause : activé au démarrage, fige réellement le déplacement', () => {
  const g = loadGame();
  g.key('ArrowUp');
  assert.deepEqual(btn(g), { disabled: false, label: 'Pause' });
  assert.equal(g.els['pause-hint'].textContent, '');
  g.clock.advance(120);
  g.click(g.els.pause);
  assert.equal(g.api.isPaused(), true);
  assert.deepEqual(btn(g), { disabled: false, label: 'Reprendre' });
  assert.equal(g.clock.count(), 0);
  assert.match(g.els.message.textContent, /Pause/);
  const frozen = head(g);
  g.clock.advance(120 * 10);
  assert.deepEqual(head(g), frozen, 'aucun déplacement pendant la pause');
});

test('bouton Reprendre : relance un unique minuteur, vitesse inchangée', () => {
  const g = loadGame();
  g.key('ArrowDown');
  for (let i = 0; i < 6; i++) {           // pause / reprise répétées
    g.click(g.els.pause);
    g.click(g.els.pause);
    assert.ok(g.clock.count() <= 1);
  }
  assert.equal(g.api.isPaused(), false);
  assert.deepEqual(btn(g), { disabled: false, label: 'Pause' });
  assert.equal(g.clock.count(), 1);
  const y0 = head(g).y;
  g.clock.advance(600);
  assert.equal(head(g).y - y0, 5, '5 pas en 600 ms : un seul minuteur');
});

test('Espace et bouton restent synchronisés dans les deux sens', () => {
  const g = loadGame();
  g.key('ArrowUp');
  g.key(' ');                                          // pause au clavier
  assert.deepEqual(btn(g), { disabled: false, label: 'Reprendre' });
  g.click(g.els.pause);                                // reprise au bouton
  assert.equal(g.api.isPaused(), false);
  assert.equal(g.clock.count(), 1);
  g.click(g.els.pause);                                // pause au bouton
  g.key(' ');                                          // reprise au clavier
  assert.equal(g.api.isPaused(), false);
  assert.deepEqual(btn(g), { disabled: false, label: 'Pause' });
  assert.equal(g.clock.count(), 1);
});

test('pause automatique au changement d\'onglet : bouton à jour, reprise au bouton', () => {
  const g = loadGame();
  g.key('ArrowUp');
  g.setHidden(true);
  assert.deepEqual(btn(g), { disabled: false, label: 'Reprendre' });
  g.setHidden(false);
  assert.equal(g.api.isPaused(), true, 'reste en pause au retour, comme avant');
  g.click(g.els.pause);
  assert.equal(g.api.isPaused(), false);
  assert.equal(g.clock.count(), 1);
});

test('Espace avec le focus sur le bouton : une seule bascule (activation native)', () => {
  const g = loadGame();
  g.key('ArrowUp');
  // Le navigateur envoie keydown (cible : le bouton) puis, au relâchement, un click natif.
  const ev = g.key(' ', { target: g.els.pause });
  assert.equal(ev.defaultPrevented, false, 'activation native du bouton préservée');
  assert.equal(g.api.isPaused(), false, 'le keydown seul ne bascule pas');
  g.click(g.els.pause);                                 // click natif
  assert.equal(g.api.isPaused(), true, 'une seule bascule au total');
  g.key(' ', { target: g.els.pause });
  g.click(g.els.pause);
  assert.equal(g.api.isPaused(), false);
  assert.equal(g.clock.count(), 1);
  // Entrée sur le bouton : même règle
  g.key('Enter', { target: g.els.pause });
  assert.equal(g.api.isPaused(), false);
  g.click(g.els.pause);
  assert.equal(g.api.isPaused(), true);
});

test('Espace avec le focus ailleurs (plateau) : bascule au keydown, comme avant', () => {
  const g = loadGame();
  g.key('ArrowUp');
  const ev = g.key(' ', { target: g.els.board });
  assert.equal(ev.defaultPrevented, true);
  assert.equal(g.api.isPaused(), true);
});

test('flèches avec le focus sur le bouton : direction prise en compte', () => {
  const g = loadGame();
  g.key('ArrowUp');
  g.clock.advance(120);
  g.key('ArrowLeft', { target: g.els.pause });
  g.clock.advance(120);
  assert.equal(g.api.getState().direction, 'left');
});

test('fin de partie : bouton désactivé, libellé Pause, aucun minuteur', () => {
  const g = loadGame();
  g.key('ArrowUp');
  g.clock.advance(120 * 20);                            // mur du haut
  assert.equal(g.api.getState().status, 'over');
  assert.deepEqual(btn(g), { disabled: true, label: 'Pause' });
  assert.match(g.els['pause-hint'].textContent, /pendant une partie/);
  assert.equal(g.click(g.els.pause), false);
  assert.equal(g.clock.count(), 0);
});

test('victoire : bouton désactivé, aucun minuteur', () => {
  const g = loadGame();
  g.key('ArrowLeft');
  const s = g.api.getState();
  const snake = [];
  for (let y = 0; y < s.rows; y++) for (let x = 0; x < s.cols; x++) snake.push({ x, y });
  snake.splice(0, 1);                                   // tout sauf (0,0), tête en (1,0)
  Object.assign(s, { snake, food: { x: 0, y: 0 }, direction: 'left', queue: [] });
  g.clock.advance(120);
  assert.equal(s.status, 'won');
  assert.deepEqual(btn(g), { disabled: true, label: 'Pause' });
  assert.equal(g.clock.count(), 0);
});

test('redémarrage pendant une pause : bouton réinitialisé, aucun minuteur en trop', () => {
  const g = loadGame();
  g.key('ArrowUp');
  g.click(g.els.pause);
  assert.equal(btn(g).label, 'Reprendre');
  g.api.restart();
  assert.deepEqual(btn(g), { disabled: true, label: 'Pause' });
  assert.equal(g.api.isPaused(), false);
  assert.equal(g.clock.count(), 0);
  g.key('ArrowDown');
  assert.deepEqual(btn(g), { disabled: false, label: 'Pause' });
  assert.equal(g.clock.count(), 1);
});

test('fin de partie puis Recommencer : état du bouton correct et record conservé', () => {
  const storage = memoryStorage();
  const g = loadGame({ setupWindow: (w) => { w.localStorage = storage; } });
  startUp(g);
  eatApples(g, 2);
  g.click(g.els.pause);
  g.click(g.els.pause);
  g.clock.advance(120 * 20);
  assert.equal(g.api.getState().status, 'over');
  g.click(g.els.restart);
  assert.deepEqual(btn(g), { disabled: true, label: 'Pause' });
  assert.equal(g.els.score.textContent, '0');
  assert.equal(g.els.best.textContent, '2');
  assert.equal(g.clock.count(), 0);
});

// --- Croix directionnelle tactile (Issue #15) ---

const DIRS = ['up', 'down', 'left', 'right'];
const pad = (g, dir) => g.els['dir-' + dir];
const padDisabled = (g) => DIRS.map((d) => pad(g, d).disabled);

test('croix tactile : active avant le démarrage, le premier toucher lance la partie', () => {
  const g = loadGame();
  assert.deepEqual(padDisabled(g), [false, false, false, false]);
  assert.equal(g.clock.count(), 0);
  g.click(pad(g, 'up'));
  assert.equal(g.clock.count(), 1, 'un seul minuteur lancé');
  assert.equal(g.els.message.textContent, '');
  assert.deepEqual(btn(g), { disabled: false, label: 'Pause' }, 'bouton Pause activé');
  const h0 = head(g);
  g.clock.advance(120);
  assert.deepEqual(head(g), { x: h0.x, y: h0.y - 1 }, 'monte d\'une case');
});

test('croix tactile : les quatre directions déplacent le serpent', () => {
  const g = loadGame();
  g.api.getState().food = { x: 0, y: 0 };
  const moves = [['up', 0, -1], ['left', -1, 0], ['down', 0, 1], ['right', 1, 0]];
  for (const [dir, dx, dy] of moves) {
    const h = head(g);
    g.click(pad(g, dir));
    g.clock.advance(120);
    assert.equal(g.api.getState().direction, dir);
    assert.deepEqual(head(g), { x: h.x + dx, y: h.y + dy }, dir);
  }
  assert.equal(g.clock.count(), 1, 'toujours un seul minuteur');
});

test('croix tactile : demi-tour immédiat refusé, y compris avec deux touchers rapides', () => {
  const g = loadGame();
  g.click(pad(g, 'up'));
  g.clock.advance(120);
  g.click(pad(g, 'down'));                              // demi-tour direct
  g.clock.advance(120);
  assert.equal(g.api.getState().direction, 'up');
  assert.equal(g.api.getState().status, 'playing');

  // Gauche puis droite pendant le même pas : droite est un demi-tour par rapport à gauche.
  g.click(pad(g, 'left'));
  g.click(pad(g, 'right'));
  g.clock.advance(120);
  assert.equal(g.api.getState().direction, 'left');
  g.clock.advance(120);
  assert.equal(g.api.getState().direction, 'left');
  assert.equal(g.api.getState().status, 'playing');
});

test('croix tactile : désactivée et sans effet pendant la pause, réactivée à la reprise', () => {
  const g = loadGame();
  g.click(pad(g, 'up'));
  g.click(g.els.pause);
  assert.deepEqual(padDisabled(g), [true, true, true, true]);
  // Même si un événement arrivait malgré tout, la direction ne change pas.
  for (const fn of pad(g, 'left').listeners.click) fn({ type: 'click' });
  assert.deepEqual([...g.api.getState().queue], ['up'], 'file de directions inchangée');
  assert.equal(g.clock.count(), 0, 'aucun minuteur relancé par la croix');
  g.click(g.els.pause);
  assert.deepEqual(padDisabled(g), [false, false, false, false]);
  assert.equal(g.clock.count(), 1);

  g.key(' ');                                           // pause au clavier : même état
  assert.deepEqual(padDisabled(g), [true, true, true, true]);
  g.setHidden(true);
  g.key(' ');
  assert.deepEqual(padDisabled(g), [false, false, false, false]);
});

test('croix tactile : désactivée en fin de partie, réactivée au redémarrage', () => {
  const g = loadGame();
  g.click(pad(g, 'up'));
  g.clock.advance(120 * 20);                            // mur du haut
  assert.equal(g.api.getState().status, 'over');
  assert.deepEqual(padDisabled(g), [true, true, true, true]);
  for (const fn of pad(g, 'down').listeners.click) fn({ type: 'click' });
  assert.equal(g.api.getState().status, 'over');
  assert.equal(g.clock.count(), 0);
  g.click(g.els.restart);
  assert.deepEqual(padDisabled(g), [false, false, false, false]);
  assert.equal(g.clock.count(), 0, 'attend le premier déplacement');
});

test('croix tactile et clavier partagent la file de directions et le minuteur', () => {
  const g = loadGame();
  g.key('ArrowUp');
  g.click(pad(g, 'left'));                              // pendant le même pas que la touche
  assert.equal(g.clock.count(), 1);
  g.clock.advance(120);
  assert.equal(g.api.getState().direction, 'up');
  g.clock.advance(120);
  assert.equal(g.api.getState().direction, 'left');
  g.key('ArrowRight');                                  // demi-tour au clavier après la croix
  g.clock.advance(120);
  assert.equal(g.api.getState().direction, 'left');
  for (let i = 0; i < 5; i++) { g.click(pad(g, 'up')); g.click(pad(g, 'left')); }
  assert.equal(g.clock.count(), 1, 'touchers répétés : un seul minuteur');
});

test('croix tactile : Espace / Entrée sur un bouton focalisé passent par le click natif', () => {
  const g = loadGame();
  g.click(pad(g, 'up'));
  const ev = g.key(' ', { target: pad(g, 'left') });
  assert.equal(ev.defaultPrevented, false, 'activation native préservée');
  assert.equal(g.api.isPaused(), false, 'Espace sur la croix ne met pas en pause');
  g.click(pad(g, 'left'));                              // click natif qui suit
  g.clock.advance(240);
  assert.equal(g.api.getState().direction, 'left');
});

test('croix tactile : un clic souris ne prend pas le focus', () => {
  const g = loadGame();
  for (const dir of DIRS) {
    const ev = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const fn of pad(g, dir).listeners.mousedown || []) fn(ev);
    assert.equal(ev.defaultPrevented, true, dir);
  }
});

test('croix tactile : le record est mis à jour comme au clavier', () => {
  const storage = memoryStorage();
  const g = loadGame({ setupWindow: (w) => { w.localStorage = storage; } });
  g.api.getState().food = { x: 0, y: 0 };
  g.click(pad(g, 'up'));
  eatApples(g, 2);
  assert.equal(g.els.score.textContent, '2');
  assert.equal(g.els.best.textContent, '2');
  assert.equal(storage.data[BEST_KEY], '2');
});
