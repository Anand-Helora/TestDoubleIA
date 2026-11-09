/*
 * Logique pure du jeu Snake (aucune dépendance au DOM).
 * Chargée en script classique dans le navigateur (global `SnakeLogic`)
 * et via `require` dans Node pour les tests unitaires.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SnakeLogic = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DIRECTIONS = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 }
  };

  var OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

  // Nombre maximal de changements de direction mémorisés entre deux pas.
  var MAX_QUEUE = 2;

  function cellKey(c) {
    return c.x + ',' + c.y;
  }

  /**
   * Choisit une cellule libre au hasard. Retourne null si la grille est pleine.
   * `random` est injectable pour rendre les tests déterministes.
   */
  function spawnFood(cols, rows, snake, random) {
    random = random || Math.random;
    var occupied = {};
    for (var i = 0; i < snake.length; i++) occupied[cellKey(snake[i])] = true;

    var free = [];
    for (var y = 0; y < rows; y++) {
      for (var x = 0; x < cols; x++) {
        if (!occupied[x + ',' + y]) free.push({ x: x, y: y });
      }
    }
    if (free.length === 0) return null;
    var idx = Math.floor(random() * free.length);
    if (idx >= free.length) idx = free.length - 1; // garde-fou si random() renvoie 1
    return free[idx];
  }

  /** Crée un nouvel état de partie. */
  function createGame(options) {
    options = options || {};
    var cols = options.cols || 20;
    var rows = options.rows || 20;
    var random = options.random || Math.random;
    var initialLength = options.initialLength || 3;

    var cx = Math.floor(cols / 2);
    var cy = Math.floor(rows / 2);
    var snake = [];
    for (var i = 0; i < initialLength; i++) {
      snake.push({ x: cx - i, y: cy }); // tête en premier, orientée vers la droite
    }

    return {
      cols: cols,
      rows: rows,
      snake: snake,
      direction: 'right',
      queue: [],
      food: spawnFood(cols, rows, snake, random),
      score: 0,
      status: 'playing', // 'playing' | 'over' | 'won'
      random: random
    };
  }

  /**
   * Enregistre une demande de changement de direction.
   * Refuse le demi-tour immédiat et la répétition de la direction courante.
   * La comparaison se fait avec la dernière direction en attente, ce qui
   * empêche de se retourner via deux touches pressées pendant un même pas
   * (ex. haut puis gauche alors que le serpent va à droite reste valide,
   * mais droite → gauche directement est refusé).
   */
  function changeDirection(state, dir) {
    if (!DIRECTIONS[dir] || state.status !== 'playing') return false;
    var last = state.queue.length ? state.queue[state.queue.length - 1] : state.direction;
    if (dir === last || dir === OPPOSITE[last]) return false;
    if (state.queue.length >= MAX_QUEUE) return false;
    state.queue.push(dir);
    return true;
  }

  /** Fait avancer la partie d'un pas. Modifie et retourne l'état. */
  function step(state) {
    if (state.status !== 'playing') return state;

    if (state.queue.length) state.direction = state.queue.shift();
    var d = DIRECTIONS[state.direction];
    var head = state.snake[0];
    var next = { x: head.x + d.x, y: head.y + d.y };

    // Collision avec les murs
    if (next.x < 0 || next.y < 0 || next.x >= state.cols || next.y >= state.rows) {
      state.status = 'over';
      return state;
    }

    var eating = state.food !== null && next.x === state.food.x && next.y === state.food.y;

    // Collision avec le corps. Si le serpent ne mange pas, la queue se libère
    // pendant ce pas : la tête peut donc prendre la place de la queue.
    var bodyToCheck = eating ? state.snake.length : state.snake.length - 1;
    for (var i = 0; i < bodyToCheck; i++) {
      if (state.snake[i].x === next.x && state.snake[i].y === next.y) {
        state.status = 'over';
        return state;
      }
    }

    state.snake.unshift(next);
    if (eating) {
      state.score += 1;
      state.food = spawnFood(state.cols, state.rows, state.snake, state.random);
      if (state.food === null) state.status = 'won'; // grille entièrement remplie
    } else {
      state.snake.pop();
    }
    return state;
  }

  /** Convertit une touche clavier (event.key) en direction, ou null. */
  function keyToDirection(key) {
    if (typeof key !== 'string') return null;
    switch (key.length === 1 ? key.toLowerCase() : key) {
      case 'ArrowUp': case 'z': case 'w': return 'up';
      case 'ArrowDown': case 's': return 'down';
      case 'ArrowLeft': case 'q': case 'a': return 'left';
      case 'ArrowRight': case 'd': return 'right';
      default: return null;
    }
  }

  return {
    DIRECTIONS: DIRECTIONS,
    createGame: createGame,
    changeDirection: changeDirection,
    step: step,
    spawnFood: spawnFood,
    keyToDirection: keyToDirection
  };
});
