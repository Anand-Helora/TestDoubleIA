// Tests du meilleur score persistant (best-score.js). Lancement : node --test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../best-score.js');

/** Stockage en mémoire au comportement de localStorage (valeurs en chaînes). */
function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); }
  };
}

const KEY = B.STORAGE_KEY;

test('clé de stockage dédiée au jeu', () => {
  assert.equal(KEY, 'snake.bestScore');
});

test('parse : accepte uniquement les entiers décimaux ≥ 0', () => {
  assert.equal(B.parse('0'), 0);
  assert.equal(B.parse('7'), 7);
  assert.equal(B.parse('0042'), 42);
  assert.equal(B.parse('9007199254740991'), 9007199254740991);
});

test('parse : refuse les valeurs invalides, négatives ou corrompues', () => {
  const invalid = [
    null, undefined, '', ' ', '-1', '-0', '+5', '1.5', '1e3', 'abc', '12abc', ' 12', '12 ',
    'NaN', 'Infinity', '-Infinity', '0x10', '[object Object]', '{"best":5}', 'null', 'true',
    '9007199254740992', '99999999999999999999', 5, {}, []
  ];
  for (const raw of invalid) assert.equal(B.parse(raw), null, JSON.stringify(raw));
});

test('initialisation : 0 sans record, record valide relu', () => {
  assert.equal(B.load(memoryStorage()), 0);
  assert.equal(B.load(memoryStorage({ [KEY]: '23' })), 23);
  assert.equal(B.createTracker(memoryStorage({ [KEY]: '23' })).get(), 23);
});

test('initialisation : valeur négative ou corrompue → 0', () => {
  for (const raw of ['-5', 'abc', '3.7', 'Infinity', '']) {
    assert.equal(B.createTracker(memoryStorage({ [KEY]: raw })).get(), 0, raw);
  }
});

test('mise à jour : seul un score strictement supérieur remplace le record', () => {
  const st = memoryStorage({ [KEY]: '5' });
  const t = B.createTracker(st);
  assert.equal(t.update(3), false);
  assert.equal(t.update(5), false);
  assert.equal(t.get(), 5);
  assert.equal(st.data[KEY], '5');
  assert.equal(t.update(6), true);
  assert.equal(t.get(), 6);
  assert.equal(st.data[KEY], '6');
});

test('mise à jour : scores invalides ignorés', () => {
  const st = memoryStorage();
  const t = B.createTracker(st);
  for (const v of [-1, 1.5, NaN, Infinity, '9', null]) assert.equal(t.update(v), false, String(v));
  assert.equal(t.get(), 0);
  assert.equal(st.data[KEY], undefined);
});

test('persistance simulée : un nouveau suivi relit le record enregistré', () => {
  const st = memoryStorage();
  const first = B.createTracker(st);
  first.update(1);
  first.update(2);
  first.update(12);
  const second = B.createTracker(st); // « nouvelle session »
  assert.equal(second.get(), 12);
});

test('valeur corrompue écrasée par le prochain record', () => {
  const st = memoryStorage({ [KEY]: 'corrompu' });
  const t = B.createTracker(st);
  assert.equal(t.get(), 0);
  t.update(1);
  assert.equal(st.data[KEY], '1');
});

test('stockage absent : valeur de secours 0, record gardé en mémoire', () => {
  const t = B.createTracker(null);
  assert.equal(t.get(), 0);
  assert.equal(t.update(4), true);
  assert.equal(t.get(), 4);
  assert.equal(B.save(null, 4), false);
});

test('getItem qui lève une exception : 0, sans propager l\'erreur', () => {
  const st = { getItem() { throw new Error('SecurityError'); }, setItem() {} };
  assert.equal(B.load(st), 0);
  assert.doesNotThrow(() => B.createTracker(st).update(3));
});

test('setItem qui lève (quota dépassé) : record conservé en mémoire', () => {
  const st = { getItem: () => '2', setItem() { throw new Error('QuotaExceededError'); } };
  const t = B.createTracker(st);
  assert.equal(B.save(st, 9), false);
  assert.equal(t.update(9), true);
  assert.equal(t.get(), 9);
});

test('getStorage : accès à localStorage qui lève, absent ou incomplet → null', () => {
  const throwing = {};
  Object.defineProperty(throwing, 'localStorage', { get() { throw new Error('SecurityError'); } });
  assert.equal(B.getStorage(throwing), null);
  assert.equal(B.getStorage({}), null);
  assert.equal(B.getStorage({ localStorage: null }), null);
  assert.equal(B.getStorage({ localStorage: { getItem() {} } }), null);
  assert.equal(B.getStorage(undefined), null);
  const ok = memoryStorage();
  assert.equal(B.getStorage({ localStorage: ok }), ok);
});
