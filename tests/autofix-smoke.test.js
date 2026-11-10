// Test témoin de l'expérience Claude Code Web Auto-fix (Issue #12).
// Étape 1 : assertion correcte (CI verte). Voir docs/autofix-ci-smoke.md.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('autofix-smoke : 1 + 1 === 3', () => {
  assert.equal(1 + 1, 3);
});
