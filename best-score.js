/*
 * Meilleur score persistant (localStorage), sans dépendance au DOM.
 * Chargé en script classique dans le navigateur (global `BestScore`)
 * et via `require` dans Node pour les tests.
 *
 * Toutes les opérations de stockage sont protégées : si localStorage est
 * indisponible, bloqué, plein ou contient une valeur corrompue, le jeu
 * continue avec la valeur de secours 0 (ou le record gardé en mémoire).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BestScore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STORAGE_KEY = 'snake.bestScore';
  var MAX_SAFE = 9007199254740991; // Number.MAX_SAFE_INTEGER (ES5)

  /**
   * Convertit une valeur brute lue dans le stockage en record valide.
   * Seule une chaîne de chiffres décimaux représentant un entier sûr ≥ 0 est
   * acceptée ; tout le reste (null, vide, négatif, décimal, texte, exposant,
   * Infinity, valeur trop grande…) retourne null.
   */
  function parse(raw) {
    if (typeof raw !== 'string' || !/^[0-9]{1,16}$/.test(raw)) return null;
    var n = parseInt(raw, 10);
    return n <= MAX_SAFE ? n : null;
  }

  /** Vrai si `n` est un score enregistrable (entier sûr ≥ 0). */
  function isValid(n) {
    return typeof n === 'number' && isFinite(n) && n >= 0 && n <= MAX_SAFE && Math.floor(n) === n;
  }

  /**
   * Récupère window.localStorage sans lever d'exception : son simple accès
   * peut lever une SecurityError (cookies bloqués, iframe sandboxée…).
   * Retourne null si le stockage est absent ou inutilisable.
   */
  function getStorage(win) {
    try {
      var s = win && win.localStorage;
      return s && typeof s.getItem === 'function' && typeof s.setItem === 'function' ? s : null;
    } catch (e) {
      return null;
    }
  }

  /** Lit le record ; 0 si stockage absent, en erreur ou valeur invalide. */
  function load(storage) {
    if (!storage) return 0;
    try {
      var value = parse(storage.getItem(STORAGE_KEY));
      return value === null ? 0 : value;
    } catch (e) {
      return 0;
    }
  }

  /** Enregistre le record. Retourne true en cas de succès, false sinon. */
  function save(storage, value) {
    if (!storage || !isValid(value)) return false;
    try {
      storage.setItem(STORAGE_KEY, String(value));
      return true;
    } catch (e) {
      return false; // quota dépassé, stockage bloqué…
    }
  }

  /**
   * Suivi du record pour une session de jeu.
   * `update(score)` met à jour le record si le score le dépasse, l'enregistre
   * et retourne true ; le record reste valable en mémoire même si
   * l'enregistrement échoue.
   */
  function createTracker(storage) {
    var best = load(storage);
    return {
      get: function () { return best; },
      update: function (score) {
        if (!isValid(score) || score <= best) return false;
        best = score;
        save(storage, best);
        return true;
      }
    };
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    parse: parse,
    isValid: isValid,
    getStorage: getStorage,
    load: load,
    save: save,
    createTracker: createTracker
  };
});
