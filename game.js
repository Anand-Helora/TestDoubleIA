/*
 * Interface navigateur du jeu Snake : rendu canvas, clavier, score, boucle.
 * S'appuie sur la logique pure exposée par snake.js (global SnakeLogic).
 */
(function () {
  'use strict';

  var COLS = 20;
  var ROWS = 20;
  var TICK_MS = 120;

  var canvas = document.getElementById('board');
  var ctx = canvas.getContext('2d');
  var scoreEl = document.getElementById('score');
  var messageEl = document.getElementById('message');
  var overlay = document.getElementById('overlay');
  var overlayTitle = document.getElementById('overlay-title');
  var restartBtn = document.getElementById('restart');

  var state = null;
  var timer = null;   // un seul minuteur actif à la fois
  var started = false;
  var paused = false;

  var cell = canvas.width / COLS;

  function stopLoop() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function startLoop() {
    stopLoop();
    timer = setInterval(tick, TICK_MS);
  }

  function newGame() {
    stopLoop();
    state = SnakeLogic.createGame({ cols: COLS, rows: ROWS });
    started = false;
    paused = false;
    overlay.hidden = true;
    updateScore();
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
    setMessage('Score final : ' + state.score + '. Appuyez sur Entrée ou cliquez sur « Recommencer ».');
    restartBtn.focus();
  }

  function togglePause() {
    if (!started || state.status !== 'playing') return;
    paused = !paused;
    if (paused) {
      stopLoop();
      setMessage('Pause — appuyez sur Espace pour reprendre.');
    } else {
      startLoop();
      setMessage('');
    }
    draw();
  }

  function updateScore() {
    scoreEl.textContent = String(state.score);
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

    if (state.status !== 'playing') {
      if (e.key === 'Enter' && document.activeElement !== restartBtn) {
        e.preventDefault();
        newGame();
      }
      return;
    }

    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      togglePause();
      return;
    }

    var dir = SnakeLogic.keyToDirection(e.key);
    if (!dir) return;
    e.preventDefault(); // évite le défilement de la page avec les flèches
    if (paused) return;

    SnakeLogic.changeDirection(state, dir);
    if (!started) {
      started = true;
      setMessage('');
      startLoop();
    }
  }

  document.addEventListener('keydown', onKeyDown);
  restartBtn.addEventListener('click', newGame);

  // Met la partie en pause si l'onglet passe en arrière-plan.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && started && !paused && state.status === 'playing') togglePause();
  });

  newGame();

  // Accès pour le débogage et les tests automatisés dans le navigateur.
  window.__snake = {
    getState: function () { return state; },
    restart: newGame
  };
})();
