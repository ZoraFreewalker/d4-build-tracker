import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLibrary } from './library.mjs';
import { resolveProfileId } from './importer.mjs';

const min = { affixes: {}, attributes: {}, items: {}, skills: {}, classes: {} };
const en = { affixes: {}, attributeDescriptions: {}, items: {}, skills: {}, uiStrings: {} };
const profile = { id: 'abc123', name: 'Test Build', data: JSON.stringify({ items: {}, profiles: [{ name: 'Starter', items: {} }, { name: 'Endgame', items: {} }] }) };

function fakeNet({ offline = false } = {}) {
  const calls = [];
  return {
    calls,
    resolveProfileId: async () => 'abc123',
    getJson: async url => {
      calls.push(url);
      if (offline) throw new Error('offline');
      if (url.includes('profiles/load')) return profile;
      return url.endsWith('data.min.json') ? min : en;
    },
  };
}

test('only Maxroll D4 links are accepted', async () => {
  await assert.rejects(resolveProfileId('https://evil.example/d4/x'), /maxroll/);
  await assert.rejects(resolveProfileId('http://maxroll.gg/d4/x'), /maxroll/);
  await assert.rejects(resolveProfileId('https://maxroll.gg/poe/x'), /maxroll/);
  await assert.rejects(resolveProfileId('niet een link'), /Maxroll/);
  assert.equal(await resolveProfileId('https://maxroll.gg/d4/planner/qeyb7t0x#1'), 'qeyb7t0x');
  assert.equal(await resolveProfileId(' qeyb7t0x '), 'qeyb7t0x');
  assert.equal(await resolveProfileId('https://maxroll.gg/d4/build-guides/x', async () => '<div data-d4-profile="zz11yy22">'), 'zz11yy22');
});

test('import saves the build, makes it active and caches game data', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'd4lib-'));
  const net = fakeNet();
  const lib = createLibrary(dir, net);
  const build = await lib.import('qeyb7t0x');
  assert.equal(build.name, 'Test Build');
  assert.deepEqual((await lib.list()).map(b => [b.id, b.phases.length]), [['maxroll-abc123', 2]]);
  const state = await lib.state();
  assert.equal(state.activeBuild, 'maxroll-abc123');
  assert.equal(state.builds['maxroll-abc123'].phase, 'Starter');

  // second import within a day: only the profile is fetched, game data comes from the cache
  net.calls.length = 0;
  await createLibrary(dir, net).import('qeyb7t0x');
  assert.deepEqual(net.calls.filter(u => !u.includes('profiles/load')), []);
});

test('stale game data falls back to the cache when offline', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'd4lib-'));
  await createLibrary(dir, fakeNet()).import('x');
  const old = new Date(Date.now() - 2 * 86400_000);
  for (const f of ['data.min.json', 'data.enus.json']) await utimes(path.join(dir, 'cache', f), old, old);
  const net = fakeNet({ offline: true });
  net.getJson = async url => (url.includes('profiles/load') ? profile : Promise.reject(new Error('offline')));
  assert.equal((await createLibrary(dir, net).import('x')).name, 'Test Build');
});

test('migrate takes over the old build.json and progress.json once', async () => {
  const oldDir = await mkdtemp(path.join(tmpdir(), 'd4old-'));
  const dir = await mkdtemp(path.join(tmpdir(), 'd4lib-'));
  await writeFile(path.join(oldDir, 'build.json'), JSON.stringify({ source: 'maxroll:q1', name: 'Old', phases: [{ name: 'Leveling', slots: {} }] }));
  await writeFile(path.join(oldDir, 'progress.json'), JSON.stringify({ phase: 'Leveling', seen: { Leveling: { Boots: { 'HIDE BOOTS': 0 } } }, window: { x: 1, y: 2, scale: 0.7 } }));
  const lib = createLibrary(dir, fakeNet());
  assert.equal(await lib.migrate(oldDir), true);
  const state = await lib.state();
  assert.deepEqual(state.builds['maxroll-q1'].seen, { Leveling: { Boots: { 'HIDE BOOTS': 0 } } });
  assert.deepEqual(state.window, { x: 1, y: 2, scale: 0.7 });
  assert.equal(await lib.migrate(oldDir), false);
});

test('remove deletes the build and picks another active one', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'd4lib-'));
  const lib = createLibrary(dir, fakeNet());
  await lib.import('x');
  await lib.remove('maxroll-abc123');
  assert.deepEqual(await lib.list(), []);
  assert.equal((await lib.state()).activeBuild, null);
});
