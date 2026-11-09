// Tests unitaires de la logique du jeu. Lancement : node --test tests/
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../snake.js');

// Fabrique un état contrôlé (serpent, pomme, direction) sans hasard.
function makeState(snake, food, direction, opts = {}) {
  const st = S.createGame({ cols: opts.cols || 10, rows: opts.rows || 10, random: () => 0 });
  st.snake = snake.map(([x, y]) => ({ x, y }));
  st.food = food ? { x: food[0], y: food[1] } : null;
  st.direction = direction || 'right';
  return st;
}

test('état initial : serpent de 3 cases, score 0, pomme hors du serpent', () => {
  const st = S.createGame({ cols: 20, rows: 20 });
  assert.equal(st.snake.length, 3);
  assert.equal(st.score, 0);
  assert.equal(st.status, 'playing');
  assert.ok(st.food);
  assert.ok(!st.snake.some((c) => c.x === st.food.x && c.y === st.food.y));
});

test('le serpent avance d\'une case sans grandir', () => {
  const st = makeState([[5, 5], [4, 5], [3, 5]], [9, 9], 'right');
  S.step(st);
  assert.deepEqual(st.snake, [{ x: 6, y: 5 }, { x: 5, y: 5 }, { x: 4, y: 5 }]);
  assert.equal(st.score, 0);
});

test('manger une pomme : +1 au score, le serpent grandit, nouvelle pomme sur une case libre', () => {
  const st = makeState([[5, 5], [4, 5], [3, 5]], [6, 5], 'right');
  S.step(st);
  assert.equal(st.score, 1);
  assert.equal(st.snake.length, 4);
  assert.ok(st.food);
  assert.ok(!st.snake.some((c) => c.x === st.food.x && c.y === st.food.y));
});

test('collision avec chacun des quatre murs', () => {
  const cases = [
    [[[9, 5], [8, 5]], 'right'],
    [[[0, 5], [1, 5]], 'left'],
    [[[5, 0], [5, 1]], 'up'],
    [[[5, 9], [5, 8]], 'down']
  ];
  for (const [snake, dir] of cases) {
    const st = makeState(snake, [0, 0], dir);
    if (dir === 'left' || dir === 'up') st.food = { x: 9, y: 9 };
    S.step(st);
    assert.equal(st.status, 'over', `mur ${dir}`);
  }
});

test('collision avec le corps', () => {
  // Serpent en forme de boucle : la tête va vers le bas dans son propre corps.
  const st = makeState([[5, 5], [6, 5], [6, 6], [5, 6], [4, 6]], [0, 0], 'down');
  S.step(st);
  assert.equal(st.status, 'over');
});

test('la tête peut entrer dans la case que la queue libère', () => {
  // Carré 2x2 : la tête suit la queue, qui se libère au même pas.
  const st = makeState([[5, 5], [6, 5], [6, 6], [5, 6]], [0, 0], 'down');
  S.step(st);
  assert.equal(st.status, 'playing');
  assert.deepEqual(st.snake[0], { x: 5, y: 6 });
});

test('mais pas si le serpent mange au même pas (la queue ne bouge pas)', () => {
  const st = makeState([[5, 5], [6, 5], [6, 6], [5, 6]], [5, 6], 'down');
  st.food = { x: 5, y: 6 }; // cas théorique : pomme sous la queue
  S.step(st);
  assert.equal(st.status, 'over');
});

test('demi-tour immédiat refusé', () => {
  const st = makeState([[5, 5], [4, 5], [3, 5]], [9, 9], 'right');
  assert.equal(S.changeDirection(st, 'left'), false);
  S.step(st);
  assert.deepEqual(st.snake[0], { x: 6, y: 5 });
  assert.equal(st.status, 'playing');
});

test('deux touches rapides pendant un même pas ne permettent pas le demi-tour', () => {
  const st = makeState([[5, 5], [4, 5], [3, 5]], [9, 9], 'right');
  assert.equal(S.changeDirection(st, 'up'), true);
  assert.equal(S.changeDirection(st, 'left'), true); // valide après « haut »
  S.step(st); // monte
  assert.deepEqual(st.snake[0], { x: 5, y: 4 });
  S.step(st); // puis va à gauche, sans se mordre
  assert.deepEqual(st.snake[0], { x: 4, y: 4 });
  assert.equal(st.status, 'playing');
});

test('haut puis bas dans un même pas : le « bas » est refusé', () => {
  const st = makeState([[5, 5], [4, 5], [3, 5]], [9, 9], 'right');
  S.changeDirection(st, 'up');
  assert.equal(S.changeDirection(st, 'down'), false);
});

test('la file de directions est limitée', () => {
  const st = makeState([[5, 5], [4, 5], [3, 5]], [9, 9], 'right');
  assert.equal(S.changeDirection(st, 'up'), true);
  assert.equal(S.changeDirection(st, 'left'), true);
  assert.equal(S.changeDirection(st, 'down'), false);
  assert.equal(st.queue.length, 2);
});

test('spawnFood ne choisit que des cases libres', () => {
  const snake = [];
  for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) if (!(x === 2 && y === 2)) snake.push({ x, y });
  for (const r of [0, 0.5, 0.999999, 1]) {
    assert.deepEqual(S.spawnFood(3, 3, snake, () => r), { x: 2, y: 2 });
  }
});

test('spawnFood renvoie null si la grille est pleine', () => {
  const snake = [{ x: 0, y: 0 }, { x: 1, y: 0 }];
  assert.equal(S.spawnFood(2, 1, snake, Math.random), null);
});

test('spawnFood : distribution sur toutes les cases libres', () => {
  const snake = [{ x: 0, y: 0 }];
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const f = S.spawnFood(3, 3, snake, Math.random);
    assert.ok(!(f.x === 0 && f.y === 0));
    seen.add(`${f.x},${f.y}`);
  }
  assert.equal(seen.size, 8);
});

test('victoire quand la dernière case libre est mangée', () => {
  const st = makeState([[1, 0], [0, 0]], [2, 0], 'right', { cols: 3, rows: 1 });
  S.step(st);
  assert.equal(st.status, 'won');
  assert.equal(st.food, null);
  assert.equal(st.score, 1);
});

test('aucun mouvement après la fin de partie', () => {
  const st = makeState([[9, 5], [8, 5]], [0, 0], 'right');
  S.step(st);
  const snapshot = JSON.stringify(st.snake);
  S.step(st);
  assert.equal(JSON.stringify(st.snake), snapshot);
  assert.equal(S.changeDirection(st, 'up'), false);
});

test('correspondance des touches : flèches, ZQSD et WASD, majuscules incluses', () => {
  const map = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    z: 'up', q: 'left', s: 'down', d: 'right',
    w: 'up', a: 'left', Z: 'up', W: 'up', Q: 'left', A: 'left', S: 'down', D: 'right'
  };
  for (const [k, v] of Object.entries(map)) assert.equal(S.keyToDirection(k), v, k);
  assert.equal(S.keyToDirection('x'), null);
  assert.equal(S.keyToDirection('Enter'), null);
  assert.equal(S.keyToDirection(undefined), null);
});
