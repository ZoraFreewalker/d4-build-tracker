import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rotatedCell, sideOf } from './board.mjs';

test('rotation is clockwise in quarter turns', () => {
  const w = 21, topGate = 10; // row 0, col 10
  assert.deepEqual(rotatedCell(topGate, w, 0), [10, 0]);
  assert.equal(sideOf(rotatedCell(topGate, w, 1), w), 'right');
  assert.equal(sideOf(rotatedCell(topGate, w, 2), w), 'bottom');
  assert.equal(sideOf(rotatedCell(topGate, w, 3), w), 'left');
  assert.deepEqual(rotatedCell(topGate, w, 4), [10, 0]);
});
