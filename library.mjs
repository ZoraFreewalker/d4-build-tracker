// Build library: imported builds, per-build phase + progress, settings and a game-data cache, all in one folder
// (the app passes Electron's userData, i.e. %APPDATA%\D4 Build Tracker).
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildFromProfile, GAME, getJson, profileUrl, resolveProfileId } from './importer.mjs';

const GAME_FILES = ['data.min.json', 'data.enus.json'];
const GAME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const readJson = async (file, fallback) => {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
};
const writeJson = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2));
};
export const buildId = source => source.replace(/[^a-z0-9]+/gi, '-');

export function createLibrary(dir, net = { getJson, resolveProfileId }) {
  const STATE = path.join(dir, 'state.json');
  const buildFile = id => path.join(dir, 'builds', `${buildId(id)}.json`);
  let state = null;

  async function loadState() {
    state ??= { activeBuild: null, builds: {}, settings: {}, window: null, ...(await readJson(STATE, {})) };
    return state;
  }
  const saveState = () => writeJson(STATE, state);

  // game data changes per patch: refresh daily, fall back to the cache when offline
  async function gameData() {
    const cacheDir = path.join(dir, 'cache');
    const files = GAME_FILES.map(f => path.join(cacheDir, f));
    const ages = await Promise.all(files.map(f => stat(f).then(s => Date.now() - s.mtimeMs, () => Infinity)));
    if (ages.every(a => a < GAME_MAX_AGE_MS)) return Promise.all(files.map(f => readJson(f)));
    try {
      const data = await Promise.all(GAME_FILES.map(f => net.getJson(`${GAME}/${f}`)));
      await Promise.all(data.map((d, i) => writeJson(files[i], d)));
      return data;
    } catch (e) {
      if (ages.some(a => a === Infinity)) throw e; // nothing cached yet
      return Promise.all(files.map(f => readJson(f)));
    }
  }

  return {
    async list() {
      const files = await readdir(path.join(dir, 'builds')).catch(() => []);
      const builds = await Promise.all(files.filter(f => f.endsWith('.json')).map(f => readJson(path.join(dir, 'builds', f))));
      return builds.filter(Boolean).map(b => ({ id: buildId(b.source), name: b.name, source: b.source, importedAt: b.importedAt, phases: b.phases.map(p => p.name) }));
    },
    get: id => readJson(buildFile(id), null),

    async import(input) {
      const id = await net.resolveProfileId(input);
      const [profile, [min, en]] = await Promise.all([net.getJson(profileUrl(id)), gameData()]);
      if (!profile?.data || !min?.affixes || !en?.affixes) throw new Error('Onverwachte data van Maxroll; is het formaat veranderd?');
      const build = buildFromProfile(profile, min, en);
      await writeJson(buildFile(build.source), build);
      await loadState();
      state.activeBuild = buildId(build.source);
      state.builds[state.activeBuild] ??= { phase: build.phases[0]?.name ?? null, seen: {} };
      await saveState();
      return build;
    },

    async remove(id) {
      await rm(buildFile(id), { force: true });
      await loadState();
      delete state.builds[id];
      if (state.activeBuild === id) state.activeBuild = (await this.list())[0]?.id ?? null;
      await saveState();
    },

    state: loadState,
    async update(change) {
      await loadState();
      change(state);
      await saveState();
      return state;
    },

    // first run of the app: take over build.json + progress.json from the old script folder
    async migrate(oldDir) {
      await loadState();
      if ((await this.list()).length) return false;
      const build = await readJson(path.join(oldDir, 'build.json'), null);
      if (!build?.phases) return false;
      await writeJson(buildFile(build.source), build);
      const old = await readJson(path.join(oldDir, 'progress.json'), {});
      state.activeBuild = buildId(build.source);
      state.builds[state.activeBuild] = { phase: old.phase ?? build.phases[0].name, seen: old.seen ?? {} };
      if (old.window) state.window = old.window;
      await saveState();
      return true;
    },
  };
}
