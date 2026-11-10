/*
 * Interface navigateur du jeu Snake : rendu canvas, clavier, score, boucle.
 * S'appuie sur la logique pure exposée par snake.js (global SnakeLogic)
 * et sur le meilleur score persistant de best-score.js (global BestScore).
 */
(function () {
  'use strict';

  var COLS = 20;
  var ROWS = 20;

  var canvas = document.getElementById('board');
  var ctx = canvas.getContext('2d');
  var scoreEl = document.getElementById('score');
  var bestEl = document.getElementById('best');
  var messageEl = document.getElementById('message');
  var overlay = document.getElementById('overlay');
  var overlayTitle = document.getElementById('overlay-title');
  var restartBtn = document.getElementById('restart');
  var pauseBtn = document.getElementById('pause');
  var pauseHint = document.getElementById('pause-hint');
  // Croix directionnelle tactile : un bouton par direction (Issue #15).
  var dirButtons = {
    up: document.getElementById('dir-up'),
    down: document.getElementById('dir-down'),
    left: document.getElementById('dir-left'),
    right: document.getElementById('dir-right')
  };
  // Sélecteur de vitesse (Issue #19) : un bouton bascule par vitesse.
  var speedHint = document.getElementById('speed-hint');
  var speedButtons = {};
  SnakeLogic.SPEED_ORDER.forEach(function (id) {
    speedButtons[id] = document.getElementById('speed-' + id);
  });

  var state = null;
  var timer = null;   // un seul minuteur actif à la fois
  var started = false;
  var paused = false;
  // Vitesse choisie, conservée d'une partie à l'autre (en mémoire uniquement).
  var speed = SnakeLogic.DEFAULT_SPEED;

  // Record persistant ; reste en mémoire si localStorage est indisponible.
  var best = BestScore.createTracker(BestScore.getStorage(window));
  var bestAtStart = 0; // record au début de la partie, pour signaler un nouveau record

  var cell = canvas.width / COLS;

  function stopLoop() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function startLoop() {
    stopLoop();
    timer = setInterval(tick, SnakeLogic.speedInterval(speed));
  }

  /** Vrai pendant une partie lancée (y compris en pause) : la vitesse y est verrouillée. */
  function inProgress() {
    return started && state.status === 'playing';
  }

  /**
   * Change la vitesse. Accepté seulement avant le premier déplacement ou en fin
   * de partie : pendant une partie (même en pause) la demande est ignorée, si
   * bien que la cadence ne change jamais en cours de jeu et qu'aucun minuteur
   * n'est créé ici. La nouvelle vitesse s'applique au prochain démarrage.
   */
  function setSpeed(id) {
    if (!SnakeLogic.isSpeed(id) || inProgress()) return false;
    speed = id;
    updateControls();
    return true;
  }

  function newGame() {
    stopLoop();
    state = SnakeLogic.createGame({ cols: COLS, rows: ROWS });
    started = false;
    paused = false;
    bestAtStart = best.get();
    overlay.hidden = true;
    updateScore();
    updateControls();
    setMessage('Appuyez sur une flèche (ou ZQSD / WASD) pour commencer.');
    draw();
    canvas.focus();
  }

  function tick() {
    SnakeLogic.step(state);
    updateScore();
    draw();
    if (state.status !== 'playing') endGame();
  }

  function endGame() {
    stopLoop();
    overlayTitle.textContent = state.status === 'won' ? 'Victoire !' : 'Partie terminée';
    overlay.hidden = false;
    var record = state.score > bestAtStart ? ' Nouveau record !' : '';
    setMessage('Score final : ' + state.score + '.' + record + ' Appuyez sur Entrée ou cliquez sur « Recommencer ».');
    updateControls();
    restartBtn.focus();
  }

  /**
   * Unique point d'entrée de la pause : touche Espace, bouton Pause/Reprendre
   * et pause automatique au changement d'onglet passent tous par ici, ce qui
   * garde un seul état (`paused`) et un seul minuteur.
   */
  function togglePause() {
    if (!started || state.status !== 'playing') return;
    paused = !paused;
    if (paused) {
      stopLoop();
      setMessage('Pause — appuyez sur Espace ou sur « Reprendre » pour continuer.');
    } else {
      startLoop();
      setMessage('');
    }
    updateControls();
    draw();
  }

  /**
   * Met le bouton en accord avec l'état du jeu. Le libellé visible change
   * (« Pause » / « Reprendre ») et sert de nom accessible : aria-pressed n'est
   * pas utilisé, car combiné à un libellé qui change il serait contradictoire
   * (« Reprendre, enfoncé »). Le changement d'état est aussi annoncé par la
   * zone aria-live du message.
   */
  function updateControls() {
    updatePauseButton();
    updateDirButtons();
    updateSpeedButtons();
  }

  function updateSpeedButtons() {
    var locked = inProgress();
    for (var id in speedButtons) {
      speedButtons[id].disabled = locked;
      speedButtons[id].setAttribute('aria-pressed', id === speed ? 'true' : 'false');
    }
    speedHint.textContent = locked ?
      'Vitesse ' + SnakeLogic.SPEEDS[speed].label + ' — verrouillée pendant la partie.' :
      'Modifiable avant le premier déplacement ou en fin de partie.';
  }

  function updatePauseButton() {
    var available = started && state.status === 'playing';
    pauseBtn.disabled = !available;
    pauseBtn.textContent = available && paused ? 'Reprendre' : 'Pause';
    pauseHint.textContent = available ? '' :
      (state.status === 'playing' ? 'Disponible une fois la partie commencée.' : 'Disponible pendant une partie.');
  }

  /**
   * La croix directionnelle suit les mêmes règles que les touches de direction :
   * utilisable avant le premier déplacement (elle démarre la partie) et pendant
   * le jeu, désactivée en pause et en fin de partie.
   */
  function updateDirButtons() {
    var available = state.status === 'playing' && !paused;
    for (var dir in dirButtons) dirButtons[dir].disabled = !available;
  }

  /**
   * Unique point d'entrée des changements de direction : clavier et croix
   * tactile passent par ici. Le demi-tour reste refusé par SnakeLogic, et le
   * minuteur n'est lancé qu'une fois, au premier déplacement.
   */
  function requestDirection(dir) {
    if (state.status !== 'playing' || paused) return;
    SnakeLogic.changeDirection(state, dir);
    if (!started) {
      started = true;
      setMessage('');
      startLoop();
      updateControls();
    }
  }

  function updateScore() {
    best.update(state.score); // met à jour et enregistre dès que le record est dépassé
    scoreEl.textContent = String(state.score);
    bestEl.textContent = String(best.get());
  }

  function setMessage(text) {
    messageEl.textContent = text;
  }

  function draw() {
    // Fond en damier léger
    for (var y = 0; y < ROWS; y++) {
      for (var x = 0; x < COLS; x++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? '#1d2b22' : '#22332a';
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }

    // Pomme
    if (state.food) {
      ctx.fillStyle = '#e5484d';
      ctx.beginPath();
      ctx.arc(state.food.x * cell + cell / 2, state.food.y * cell + cell / 2, cell * 0.38, 0, Math.PI * 2);
      ctx.fill();
    }

    // Serpent
    for (var i = state.snake.length - 1; i >= 0; i--) {
      var s = state.snake[i];
      ctx.fillStyle = i === 0 ? '#b5f05a' : '#6cc04a';
      ctx.fillRect(s.x * cell + 1, s.y * cell + 1, cell - 2, cell - 2);
    }

    if (paused) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 28px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Pause', canvas.width / 2, canvas.height / 2);
    }
  }

  function onKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // Espace ou Entrée sur un bouton actif : seule l'activation native du
    // bouton (événement click) déclenche l'action. Le bouton garde ainsi son
    // comportement clavier standard, et la pause ne peut pas être basculée à
    // la fois par ce gestionnaire et par le click, sans dépendre de la façon
    // dont preventDefault() interagit avec l'activation native.
    var t = e.target;
    if (t && t.tagName === 'BUTTON' && !t.disabled &&
        (e.key === ' ' || e.key === 'Spacebar' || e.key === 'Enter')) {
      return;
    }

    if (state.status !== 'playing') {
      if (e.key === 'Enter' && document.activeElement !== restartBtn) {
        e.preventDefault();
        if (!e.repeat) newGame();
      }
      return;
    }

    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      // Une touche maintenue génère des keydown répétés (e.repeat = true) :
      // seule une nouvelle pression distincte doit basculer la pause.
      if (!e.repeat) togglePause();
      return;
    }

    var dir = SnakeLogic.keyToDirection(e.key);
    if (!dir) return;
    e.preventDefault(); // évite le défilement de la page avec les flèches
    requestDirection(dir);
  }

  document.addEventListener('keydown', onKeyDown);
  restartBtn.addEventListener('click', newGame);
  pauseBtn.addEventListener('click', togglePause);

  Object.keys(speedButtons).forEach(function (id) {
    var b = speedButtons[id];
    b.addEventListener('click', function () { setSpeed(id); });
    // Comme la croix : un clic souris ne prend pas le focus, pour que les
    // flèches et Espace continuent de piloter le jeu juste après le choix.
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
  });

  Object.keys(dirButtons).forEach(function (dir) {
    var b = dirButtons[dir];
    // click couvre souris, toucher et activation clavier (Espace / Entrée sur le
    // bouton focalisé) ; touch-action: manipulation (CSS) supprime le délai tactile.
    b.addEventListener('click', function () { requestDirection(dir); });
    // Un clic souris ne prend pas le focus : Espace continue de mettre en pause
    // au lieu de réactiver le dernier bouton de direction utilisé.
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
  });

  // Met la partie en pause si l'onglet passe en arrière-plan.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && started && !paused && state.status === 'playing') togglePause();
  });

  newGame();

  // Accès réservé aux tests automatisés : exposé uniquement avec ?test dans l'URL
  // (ex. index.html?test), jamais en jeu normal.
  if (/[?&]test(=|&|$)/.test(window.location.search)) {
    window.__snake = {
      getState: function () { return state; },
      isPaused: function () { return paused; },
      getSpeed: function () { return speed; },
      getTickMs: function () { return SnakeLogic.speedInterval(speed); },
      restart: newGame
    };
  }
})();
