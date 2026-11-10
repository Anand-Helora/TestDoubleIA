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

  /**
   * Vitesses proposées (Issue #19) : durée d'un pas en millisecondes.
   * « Normal » reprend exactement la cadence historique (120 ms).
   */
  var SPEEDS = {
    slow: { label: 'Lent', intervalMs: 180 },
    normal: { label: 'Normal', intervalMs: 120 },
    fast: { label: 'Rapide', intervalMs: 80 }
  };
  var SPEED_ORDER = ['slow', 'normal', 'fast'];
  var DEFAULT_SPEED = 'normal';

  /** Vrai si `id` est une vitesse connue (propriété propre uniquement). */
  function isSpeed(id) {
    return typeof id === 'string' && Object.prototype.hasOwnProperty.call(SPEEDS, id);
  }

  /** Durée d'un pas pour la vitesse `id` ; vitesse normale si `id` est inconnu. */
  function speedInterval(id) {
    return SPEEDS[isSpeed(id) ? id : DEFAULT_SPEED].intervalMs;
  }

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

  function isPositiveInt(n) {
    // isFinite (ES5) exclut Infinity, -Infinity et NaN.
    return typeof n === 'number' && isFinite(n) && n >= 1 && Math.floor(n) === n;
  }

  /**
   * Crée un nouvel état de partie.
   * Dimensions et longueur doivent être des entiers ≥ 1 (sinon RangeError).
   * La longueur initiale est ramenée à la largeur de la grille, et le serpent
   * est toujours placé entièrement dans la grille, sur la ligne centrale.
   */
  function createGame(options) {
    options = options || {};
    var cols = options.cols === undefined ? 20 : options.cols;
    var rows = options.rows === undefined ? 20 : options.rows;
    var initialLength = options.initialLength === undefined ? 3 : options.initialLength;
    var random = options.random || Math.random;

    if (!isPositiveInt(cols) || !isPositiveInt(rows)) {
      throw new RangeError('cols et rows doivent être des entiers ≥ 1');
    }
    if (!isPositiveInt(initialLength)) {
      throw new RangeError('initialLength doit être un entier ≥ 1');
    }
    initialLength = Math.min(initialLength, cols);

    // Tête au centre, sauf si la queue sortirait de la grille par la gauche.
    var headX = Math.max(Math.floor(cols / 2), initialLength - 1);
    var cy = Math.floor(rows / 2);
    var snake = [];
    for (var i = 0; i < initialLength; i++) {
      snake.push({ x: headX - i, y: cy }); // tête en premier, orientée vers la droite
    }

    var food = spawnFood(cols, rows, snake, random);
    return {
      cols: cols,
      rows: rows,
      snake: snake,
      direction: 'right',
      queue: [],
      food: food,
      score: 0,
      status: food === null ? 'won' : 'playing', // 'playing' | 'over' | 'won'
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
    keyToDirection: keyToDirection,
    SPEEDS: SPEEDS,
    SPEED_ORDER: SPEED_ORDER,
    DEFAULT_SPEED: DEFAULT_SPEED,
    isSpeed: isSpeed,
    speedInterval: speedInterval
  };
});
