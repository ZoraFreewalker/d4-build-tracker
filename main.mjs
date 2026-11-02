// D4 Build Tracker: overlay (tabs Gear/Skills/Paragon), detail view, control window and tray.
// While Diablo IV runs it captures the screen every PERIOD_MS, OCRs tooltips and compares them with the build.
// Usage: npm start                 (live)
//        npm start -- --image <f>  (test with a screenshot instead of the screen)
// The overlay is click-through except over its interactive parts (header, and the panel on Skills/Paragon).
import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import updaterPkg from 'electron-updater';
import { SCHEMA } from './importer.mjs';
import { createLibrary } from './library.mjs';
import { compare, levelingStep, outside, parseTooltips, phaseForLevel, progress, readLevel, sameSlot, screenContext, verdict } from './tracker.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
// the .ps1 scripts must be real files for powershell, so the installer ships them next to app.asar
const script = name => (app.isPackaged ? path.join(process.resourcesPath, name) : path.join(DIR, name));
const ICON = path.join(DIR, 'icon.png');
const PERIOD_MS = 250; // loop tick; capturing only happens when the cursor rests (see shouldCapture)
const REST_MS = 150, RECHECK_MS = 1500;
const GAME_PROCESS = /^Diablo IV$/i;
const CROP_WIDTH = 2000; // px of the frame kept around the cursor
const FRAME = path.join(tmpdir(), 'd4-tracker-frame');
const BASE = { width: 380, height: 620 }; // overlay size at scale 1
const SCALE_MIN = 0.5, SCALE_MAX = 2.5;
const MIN_HEIGHT = 160; // DIP, enough for the header
const DEFAULT_SETTINGS = { ocr: true, notify: true, opacity: 0.94, overlayOpacity: 1, hotkeys: { overlay: 'Alt+Shift+O', exclusive: 'Alt+Shift+I', detail: 'Alt+Shift+B', capture: 'Alt+Shift+S' } };
const imageArg = process.argv.includes('--image') ? path.resolve(process.argv[process.argv.indexOf('--image') + 1]) : null;

if (process.env.D4_USER_DATA) app.setPath('userData', process.env.D4_USER_DATA); // dev: fresh profile
// second start: the running app shows its window (second-instance); exit before spawning helpers
if (!app.requestSingleInstanceLock()) process.exit(0);

const lib = createLibrary(app.getPath('userData'));
let state, build = null;
let overlay, detail, control, tray;

const settings = () => ({ ...DEFAULT_SETTINGS, ...state.settings, hotkeys: { ...DEFAULT_SETTINGS.hotkeys, ...state.settings?.hotkeys } });
const buildState = () => (state.builds[state.activeBuild] ??= { phase: null, seen: {} });
const phases = () => build?.phases ?? [];
const phase = () => phases().find(p => p.name === buildState().phase) ?? phases()[0] ?? null;
const save = () => lib.update(() => {}).catch(e => console.error('save failed', e));

async function loadActiveBuild() {
  build = state.activeBuild ? await lib.get(state.activeBuild) : null;
  if (build && !phases().some(p => p.name === buildState().phase)) buildState().phase = phases()[0]?.name ?? null;
  sendBuild();
  updateVisibility();
  upgradeBuild();
}

// builds imported by an older version miss newer fields (stat priority, drop locations): re-import them once
const upgraded = new Set();
function upgradeBuild() {
  const id = build?.source?.startsWith('maxroll:') && build.source.slice('maxroll:'.length);
  if (!id || (build.schema ?? 1) >= SCHEMA || upgraded.has(id)) return;
  upgraded.add(id);
  lib.import(id).then(async () => { state = await lib.state(); await loadActiveBuild(); })
    .catch(e => console.error('re-import failed (offline?)', e.message));
}

// ---------- OCR ----------
// one long-running OCR process; replies come back in request order
const ocrProc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script('ocr.ps1'), '-Server'], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
const waiting = [];
readline.createInterface({ input: ocrProc.stdout }).on('line', line => waiting.shift()?.(line));
function ocr(file) {
  return new Promise((resolve, reject) => {
    waiting.push(line => {
      const out = JSON.parse(line.replace(/[\u0000-\u001f]/g, ' ')); // D4 bullet glyphs
      out.error ? reject(new Error(out.error)) : resolve(out);
    });
    ocrProc.stdin.write(`${file}\n`);
  });
}

// Captures the primary display. crop 'cursor' keeps a band around the cursor (tooltips sit next to it),
// 'right' the right side (the ABILITIES panel, character screen), 'left' the left edge (level-up message), 'none' everything. Returns the file and the band's x offset.
async function grabScreen({ crop = 'cursor' } = {}) {
  const d = screen.getPrimaryDisplay();
  const width = Math.round(d.size.width * d.scaleFactor), height = Math.round(d.size.height * d.scaleFactor);
  let offsetX = 0, cropWidth = width;
  if (crop === 'cursor' && width > CROP_WIDTH) {
    const cx = (screen.getCursorScreenPoint().x - d.bounds.x) * d.scaleFactor;
    // tooltips open mostly to the left of the hovered item (inventory/character panel are on the right)
    offsetX = Math.round(Math.min(Math.max(0, cx - CROP_WIDTH * 0.65), width - CROP_WIDTH));
    cropWidth = CROP_WIDTH;
  } else if (crop === 'right') {
    offsetX = Math.round(width * 0.6);
    cropWidth = width - offsetX;
  } else if (crop === 'left') {
    cropWidth = Math.round(width * 0.2);
  }
  const t0 = Date.now();
  const bytes = await grabFromStream(offsetX, cropWidth);
  let file;
  if (bytes) {
    file = `${FRAME}-${Date.now()}.jpg`;
    await writeFile(file, bytes);
  } else {
    // stream not running (yet): slow path, a fresh capture session per call (~600 ms)
    const [src] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
    file = await writeFrame(maxChannel(src.thumbnail.crop({ x: offsetX, y: 0, width: cropWidth, height })));
  }
  if (process.env.D4_DEBUG) console.log(`capture ${Date.now() - t0}ms via ${bytes ? `stream ${bytes.length} bytes` : "getSources"} (${crop})`);
  return { file, offsetX };
}

// ---------- screen stream in a hidden window (see capture.html) ----------
let captureWin = null, captureOn = false, grabId = 0;
const grabs = new Map();
function setCapture(on) {
  if (on === captureOn) return;
  captureOn = on;
  if (!on) return captureWin?.webContents.send('capture-stop');
  (async () => {
    if (!captureWin) {
      captureWin = new BrowserWindow({ show: false, webPreferences: { preload: path.join(DIR, 'preload.cjs'), backgroundThrottling: false } });
      ipcMain.on('grab-result', (_e, id, bytes) => { grabs.get(id)?.(bytes ? Buffer.from(bytes) : null); grabs.delete(id); });
      await captureWin.loadFile(path.join(DIR, 'capture.html'));
    }
    const d = screen.getPrimaryDisplay();
    const [src] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    if (captureOn && src) captureWin.webContents.send('capture-start', { sourceId: src.id, width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) });
  })().catch(e => console.error('capture stream setup failed', e));
}
function grabFromStream(x, width) {
  if (!captureWin || !captureOn) return Promise.resolve(null);
  const id = ++grabId;
  return new Promise(resolve => {
    grabs.set(id, resolve);
    captureWin.webContents.send('grab', { id, x, width });
    setTimeout(() => { if (grabs.delete(id)) resolve(null); }, 2000);
  });
}

// every pixel becomes its brightest channel: colored text (red "-21.5%", blue values) turns white for the OCR
function maxChannel(img) {
  const { width, height } = img.getSize();
  const px = img.toBitmap(); // BGRA
  for (let i = 0; i < px.length; i += 4) px[i] = px[i + 1] = px[i + 2] = Math.max(px[i], px[i + 1], px[i + 2]);
  return nativeImage.createFromBitmap(px, { width, height });
}

// new file per frame: the WinRT reader keeps the previous one locked for a while
async function writeFrame(img) {
  const file = `${FRAME}-${Date.now()}.jpg`;
  await writeFile(file, img.toJPEG(85));
  return file;
}

// our own windows in frame pixels; the overlay is not hidden from captures (transparent windows ignore
// content protection), so its text must be dropped from the OCR result
function ownRects() {
  const d = screen.getPrimaryDisplay();
  return [overlay, detail, toast].filter(w => w && !w.isDestroyed() && w.isVisible()).map(w => {
    const b = w.getBounds();
    return { x: (b.x - d.bounds.x) * d.scaleFactor, y: (b.y - d.bounds.y) * d.scaleFactor, width: b.width * d.scaleFactor, height: b.height * d.scaleFactor };
  });
}
const cursorOnOwnWindow = () => {
  const p = screen.getCursorScreenPoint();
  return [overlay, detail].some(w => w && !w.isDestroyed() && w.isVisible() && (b => p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height)(w.getBounds()));
};

// ---------- foreground: the overlay only lives on top of Diablo IV ----------
// gameRunning = D4 is the foreground window (or one of our own windows, e.g. ⚙ opened from the overlay)
let gameRunning = !!process.env.D4_FORCE_GAME, userHidden = false; // D4_FORCE_GAME: dev, measure capture cost without the game
const focusProc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script('focus.ps1'), '-ParentPid', String(process.pid)], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
readline.createInterface({ input: focusProc.stdout }).on('line', line => {
  const [pid, name] = line.split('|');
  if (Number(pid) === process.pid || process.env.D4_FORCE_GAME) return; // our own window in front: keep the current state
  gameRunning = GAME_PROCESS.test(name ?? '');
  if (process.env.D4_DEBUG) console.log('foreground', name, '-> overlay', gameRunning ? 'on' : 'off');
  updateVisibility();
});

function updateVisibility() {
  if (exclusive && !(gameRunning || imageArg)) toggleExclusive(false); // alt-tabbed away: drop the dim layer too
  setCapture(!imageArg && !process.env.D4_NO_STREAM && gameRunning && settings().ocr); // the screen stream only runs while D4 is in front
  const show = !!imageArg || (gameRunning && !userHidden && !!build);
  for (const w of [overlay, detail]) {
    if (!w || w.isDestroyed()) continue;
    if (show && !w.isVisible()) w.showInactive();
    else if (!show && w.isVisible()) w.hide();
  }
}
const toggleOverlay = () => { userHidden = !userHidden; updateVisibility(); };

async function keepFrame(kind, frame, lines) {
  const base = path.join(app.getPath('userData'), 'debug', `${kind}-${Date.now()}`);
  await mkdir(path.dirname(base), { recursive: true });
  await copyFile(frame, `${base}.jpg`);
  await writeFile(`${base}.json`, JSON.stringify(lines, null, 1));
}
// a tooltip was on screen but not parsed: keep the frame + OCR (max one per 10 s) so it can be fixed
let lastKept = 0;
async function keepUnrecognized(frame, lines) {
  if (Date.now() - lastKept < 10_000) return;
  lastKept = Date.now();
  await keepFrame('unrecognized', frame, lines);
}

// hotkey: save the whole screen + its OCR (e.g. skill tree, paragon) so new screens can be supported
async function captureScreen() {
  if (!gameRunning && !imageArg) return;
  const { file } = await grabScreen({ crop: 'none' });
  const lines = await ocr(file);
  const base = path.join(app.getPath('userData'), 'debug', `screen-${Date.now()}`);
  await mkdir(path.dirname(base), { recursive: true });
  await copyFile(file, `${base}.jpg`);
  await writeFile(`${base}.json`, JSON.stringify(lines, null, 1));
  rm(file, { force: true }).catch(() => {});
  send({ notice: 'Scherm opgeslagen voor analyse' });
}

// ---------- in-game screen: skill tree / paragon open? ----------
// context switches the overlay to the matching tab while that screen is open
let context = null, paragonKept = false, contextMisses = 0;
async function detectContext() {
  const { file, offsetX } = await grabScreen({ crop: 'right' });
  let lines;
  try { lines = await ocr(file); } finally { setTimeout(() => rm(file, { force: true }).catch(() => {}), 2000); }
  lines = outside(lines.map(l => ({ ...l, x: l.x + offsetX })), ownRects());
  setLevel(readLevel(lines));
  const next = screenContext(lines);
  // the paragon screen is only inferred (no sample yet): keep the first one so detection can be verified
  if (next === 'paragon' && !paragonKept) {
    paragonKept = true;
    await keepFrame('paragon', file, lines).catch(() => {});
  }
  // a single missed read (a node tooltip covering the header) must not close the skills view: leave only
  // after 2 misses in a row (~6 s)
  contextMisses = next ? 0 : contextMisses + 1;
  if (!next && context && contextMisses < 2) return;
  if (next !== context) { context = next; send(); }
}

// ---------- character level: character screen (via detectContext) + level-up message ----------
async function detectLevelUp() {
  const { file } = await grabScreen({ crop: 'left' });
  let lines;
  try { lines = await ocr(file); } finally { setTimeout(() => rm(file, { force: true }).catch(() => {}), 2000); }
  setLevel(readLevel(outside(lines, ownRects())));
}
// the leveling order: the phase whose skill tree has the most milestones (e.g. "Leveling Skill Tree")
const levelingPhase = () => phases().reduce((best, p) => ((p.skills?.steps.length ?? 0) > (best?.skills?.steps.length ?? 1) ? p : best), null);
function setLevel(found) {
  if (!found || found.level === state.level) return;
  // the message stays on screen a few seconds: it only moves forward; the character screen is the truth (other character)
  if (found.source === 'levelup' && found.level < (state.level ?? 0)) return;
  const up = found.level > (state.level ?? Infinity);
  state.level = found.level;
  save();
  const next = phaseForLevel(phases().map(p => p.name), phase()?.name, found.level);
  if (next) {
    buildState().phase = next;
    sendBuild();
    return notify(`Level ${found.level}: fase → ${next}`, 'ok');
  }
  const steps = levelingPhase()?.skills.steps;
  if (up && steps) {
    const { index, points } = levelingStep(steps, found.level);
    const total = steps[index].nodes.reduce((n, x) => n + x.rank, 0);
    notify(`Level ${found.level} · skillpunt ${points}: mijlpaal "${steps[index].name}" (${total} pnt)`, 'ok');
  } else if (up) notify(`Level ${found.level}`, 'ok');
  send();
}

// what the remembered equipped items have per build slot (stat values for "nodig 30 · nu 14")
function currentGear(ph) {
  const out = {};
  for (const item of Object.values(buildState().equipped ?? {}).flat()) {
    const r = compare(item, ph);
    if (!r) continue;
    // a second ring / one-handed weapon fills the next slot of that kind ("Ring 2", "Sword 2")
    let slot = r.slot.split(', ')[0];
    const base = slot.replace(/ \d+$/, '');
    for (let n = 2; out[slot] && ph.slots[`${base} ${n}`]; n++) slot = `${base} ${n}`;
    if (out[slot]) continue;
    out[slot] = { name: item.name, affixes: r.affixes.map(a => ({ text: a.text, status: a.status, have: a.have, max: a.max })) };
  }
  return out;
}

// ---------- overlay data ----------
let lastSent = '';
function send(extra = {}) {
  const ph = phase();
  const data = JSON.stringify({
    build: build?.name ?? null, phase: ph?.name ?? null, phases: phases().map(p => p.name),
    gameRunning: gameRunning || !!imageArg, ocr: settings().ocr, hotkeys: settings().hotkeys, opacity: settings().opacity, exclusive,
    level: state.level ?? null, levelStep: state.level && levelingPhase() ? levelingStep(levelingPhase().skills.steps, state.level).index : null,
    progress: ph ? progress(ph, buildState().seen[ph.name]) : null, current: ph ? currentGear(ph) : {}, context, results: [], ...extra,
  });
  if (data === lastSent) return;
  lastSent = data;
  for (const w of [overlay, detail]) if (w && !w.isDestroyed()) w.webContents.send('update', JSON.parse(data));
}
// the full phase (skills, paragon) only goes out when build or phase changes
function sendBuild() {
  const lv = levelingPhase();
  const payload = { name: build?.name ?? null, phase: phase(), leveling: lv ? { from: lv.name, steps: lv.skills.steps } : null };
  overlay?.webContents.send('build', payload);
  detail?.webContents.send('build', payload);
  lastSent = '';
  send();
}

// A tooltip only shows while the cursor rests on an item, so a moving cursor costs nothing: capture as soon
// as it has rested REST_MS, then only every RECHECK_MS while it stays on the same spot. This is what keeps
// the game's FPS up (a full-screen capture + OCR every tick used ~60% of a CPU core).
let lastCursor = null, restSince = 0, lastCaptureAt = 0, lastCaptureCursor = null;
function shouldCapture() {
  const p = screen.getCursorScreenPoint(), now = Date.now();
  const moved = !lastCursor || Math.abs(p.x - lastCursor.x) + Math.abs(p.y - lastCursor.y) > 6;
  lastCursor = p;
  if (moved) {
    restSince = now;
    // the cursor left the item: its tooltip is gone too
    if (lastResults.length && now - lastCaptureAt > RECHECK_MS) { lastResults = []; send({ results: [] }); }
    return false;
  }
  if (now - restSince < REST_MS) return false;
  const samePlace = lastCaptureCursor && lastCaptureCursor.x === p.x && lastCaptureCursor.y === p.y;
  if (samePlace && now - lastCaptureAt < RECHECK_MS) return false;
  lastCaptureAt = now;
  lastCaptureCursor = p;
  return true;
}

async function tick() {
  const ph = phase();
  if (!ph) return send();
  // the player is scrolling/dragging the overlay: no tooltip to read, and capturing would make it stutter
  if (!imageArg && (dragTimer || exclusive || cursorOnOwnWindow() || !shouldCapture())) return;
  // test images go through the same color step as live frames
  const testImg = imageArg && nativeImage.createFromPath(imageArg); // empty for formats Electron can't read (webp)
  const { file: frame, offsetX } = !imageArg ? await grabScreen() : { file: testImg.isEmpty() ? imageArg : await writeFrame(maxChannel(testImg)), offsetX: 0 };
  let lines;
  try { lines = await ocr(frame); } finally { if (frame !== imageArg) setTimeout(() => rm(frame, { force: true }).catch(() => {}), 2000); }
  for (const l of lines) l.x += offsetX;
  if (!imageArg) lines = outside(lines, ownRects());
  else { context = screenContext(lines); setLevel(readLevel(lines)); } // test images: screen + level from the same frame
  const tooltips = parseTooltips(lines);
  if (!imageArg && !tooltips.length && lines.some(l => /item power/i.test(l.text))) await keepUnrecognized(frame, lines);
  if (process.env.D4_DEBUG) console.log('ocr lines', lines.length, lines.slice(0, 3).map(l => l.text).join(' | '));
  if (process.env.D4_DEBUG) console.log('tooltips', JSON.stringify(tooltips.map(t => ({ name: t.name, equipped: t.equipped, power: t.power, deltas: t.deltas }))));
  for (const t of tooltips.filter(t => t.equipped && t.name)) rememberEquipped(t);
  const results = tooltips.map(t => {
    const match = compare(t, ph);
    // the item to compare with: the equipped tooltip on screen, else the weakest remembered one of that kind
    const equipped = t.equipped ? null : tooltips.find(e => e.equipped && sameSlot(e.slotType, t.slotType)) ?? weakestEquipped(t, ph);
    return {
      name: t.name, type: `${t.ancestral ? 'Ancestral ' : ''}${t.rarity} ${t.type}`, power: t.power, equipped: t.equipped, match,
      // progress is kept per build slot type: an equipped axe can fill the build's "Sword" (dual-wield) slots
      slotType: match?.slot.split(', ')[0].replace(/ \d+$/, '') ?? t.slotType,
      verdict: t.equipped || t.slotType === 'Aspect' ? null : { ...verdict(t, equipped, ph), against: equipped?.name ?? null },
    };
  });
  const before = progress(ph, buildState().seen[ph.name]).percent;
  for (const r of results.filter(r => r.equipped && r.match && r.name)) {
    const seen = ((buildState().seen[ph.name] ??= {})[r.slotType] ??= {});
    if (seen[r.name] !== r.match.score) { seen[r.name] = r.match.score; save(); }
  }
  const after = progress(ph, buildState().seen[ph.name]).percent;
  if (after > before) notify(`Build-voortgang ${before}% → ${after}%`, 'ok');
  for (const r of results.filter(r => r.verdict?.kind === 'upgrade')) notifyOnce(r.name, `▲ Upgrade: ${r.name || 'item'}${r.verdict.pos[0] ? ` (${r.verdict.pos[0]})` : ''}`);

  // OCR misses a frame now and then (mouse moving, tooltip fading in): keep the last result for ~1 s
  if (!results.length && lastResults.length && ++emptyTicks < 3) return send({ results: lastResults });
  emptyTicks = 0;
  lastResults = results;
  send({ results });
}
let lastResults = [], emptyTicks = 0;

// ---------- notifications: a small toast, also when the overlay is hidden ----------
let toast, toastTimer, toastReady;
const notified = new Map(); // item name -> time, so one drop is announced once
function notifyOnce(key, text) {
  if (Date.now() - (notified.get(key) ?? 0) < 60_000) return;
  notified.set(key, Date.now());
  notify(text, 'ok');
}
function notify(text, kind) {
  if (process.env.D4_DEBUG) console.log('notify', text);
  if (settings().notify === false || (!gameRunning && !imageArg)) return;
  if (!toast || toast.isDestroyed()) {
    const { workArea } = screen.getPrimaryDisplay();
    toast = new BrowserWindow({
      x: workArea.x + Math.round(workArea.width / 2 - 260), y: workArea.y + 40, width: 520, height: 64, show: false,
      transparent: true, frame: false, alwaysOnTop: true, focusable: false, skipTaskbar: true, resizable: false, hasShadow: false,
      webPreferences: { preload: path.join(DIR, 'preload.cjs'), backgroundThrottling: false },
    });
    toast.setAlwaysOnTop(true, 'screen-saver');
    toast.setIgnoreMouseEvents(true);
    toastReady = toast.loadFile(path.join(DIR, 'overlay.html'), { hash: 'toast' });
  }
  // the first message waits for the page; isLoading() is still false right after loadFile()
  toastReady.then(() => { if (toast.isDestroyed()) return; toast.webContents.send('toast', { text, kind }); toast.showInactive(); });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast?.isDestroyed() || toast.hide(), 2500);
}

// equipped items seen in tooltips, so a new drop can be judged without the comparison tooltip on screen.
// Per item type the latest one is kept (two for rings and one-handed weapons, which are worn in pairs).
function rememberEquipped(t) {
  const store = (buildState().equipped ??= {});
  const list = (store[t.slotType] ?? []).filter(e => e.name !== t.name);
  const keep = t.slotType === 'Ring' || sameSlot(t.slotType, 'Sword') ? 2 : 1;
  const item = { name: t.name, slotType: t.slotType, rarity: t.rarity, power: t.power, body: t.body, affixLines: t.affixLines, seenAt: Date.now() };
  const prev = store[t.slotType]?.find(e => e.name === t.name);
  store[t.slotType] = [item, ...list].slice(0, keep);
  if (!prev || prev.body !== t.body || prev.power !== t.power) save();
}
function weakestEquipped(t, ph) {
  const all = Object.values(buildState().equipped ?? {}).flat().filter(e => sameSlot(e.slotType, t.slotType));
  return all.sort((a, b) => (compare(a, ph)?.score ?? 0) - (compare(b, ph)?.score ?? 0))[0] ?? null;
}

// ---------- overlay window: scale, drag, click-through ----------
// x/y passed in during a drag: re-reading getPosition each step drifts under Windows display scaling
// width follows the scale (text size); the height is free (more or less of the lists), like a normal window
const clampScale = s => Math.min(SCALE_MAX, Math.max(SCALE_MIN, s));
const winHeight = () => state.window.height ?? Math.round(BASE.height * state.window.scale);
function applyScale(scale, [x, y] = overlay.getPosition(), height = winHeight()) {
  state.window.scale = clampScale(scale);
  const maxH = screen.getPrimaryDisplay().workArea.height;
  state.window.height = Math.round(Math.min(maxH, Math.max(MIN_HEIGHT, height)));
  overlay.setBounds({ x, y, width: Math.round(BASE.width * state.window.scale), height: state.window.height });
  overlay.webContents.setZoomFactor(state.window.scale);
}

// move/scale by polling the cursor: the window follows it, so the mouseup still lands on the overlay
let dragTimer = null;
// mode: 'move', 'scale' (the ⤡ grip, proportional) or 'resize-<n|s|e|w|ne|nw|se|sw>' (window edges/corners)
function startDrag(mode) {
  if (state.window.locked) return;
  clearInterval(dragTimer);
  const start = screen.getCursorScreenPoint();
  const [x, y] = overlay.getPosition();
  const scale = state.window.scale, w0 = Math.round(BASE.width * scale), h0 = winHeight();
  const edges = mode.startsWith('resize-') ? mode.slice(7) : '';
  let last = start, stillSince = Date.now();
  dragTimer = setInterval(() => {
    const p = screen.getCursorScreenPoint(), dx = p.x - start.x, dy = p.y - start.y;
    // The mouseup only reaches us while the cursor is over the overlay. When an edge stops at the minimum or
    // maximum size and the cursor runs on, the release happens outside and the drag would never end
    // (overlay stuck until restart). So: end once the cursor is clearly outside, or hasn't moved for a while.
    const b = overlay.getBounds();
    if (p.x < b.x - 40 || p.x > b.x + b.width + 40 || p.y < b.y - 40 || p.y > b.y + b.height + 40) return endDrag();
    if (p.x !== last.x || p.y !== last.y) { last = p; stillSince = Date.now(); } else if (Date.now() - stillSince > 4000) return endDrag();
    // setBounds with a fixed size: setPosition alone makes the window grow under Windows display scaling
    if (mode === 'move') return overlay.setBounds({ x: x + dx, y: y + dy, width: w0, height: h0 });
    if (mode === 'scale') {
      const next = clampScale(scale + dx / BASE.width);
      return applyScale(next, [x, y], h0 * (next / scale));
    }
    // edges: the opposite side stays where it is, as with a Windows window
    const next = clampScale((edges.includes('e') ? w0 + dx : edges.includes('w') ? w0 - dx : w0) / BASE.width);
    const w = Math.round(BASE.width * next);
    const maxH = screen.getPrimaryDisplay().workArea.height;
    const h = Math.round(Math.min(maxH, Math.max(MIN_HEIGHT, edges.includes('s') ? h0 + dy : edges.includes('n') ? h0 - dy : h0)));
    applyScale(next, [edges.includes('w') ? x + w0 - w : x, edges.includes('n') ? y + h0 - h : y], h);
  }, 16);
}
function endDrag() {
  if (!dragTimer) return;
  clearInterval(dragTimer);
  dragTimer = null;
  [state.window.x, state.window.y] = overlay.getPosition();
  save();
}

// click-through except over the rects the renderer reports; we poll the cursor instead of { forward: true },
// whose system-wide mouse hook stalls the mouse while this process is busy capturing the screen
function watchInteractive(win, scaleOf, rectsRef) {
  let interactive = false;
  win.setIgnoreMouseEvents(true);
  // after hide/show the window's click-through flag must be set again; null forces that on the next poll
  win.on('show', () => { interactive = null; });
  setInterval(() => {
    if (win.isDestroyed() || !win.isVisible()) return;
    const p = screen.getCursorScreenPoint(), b = win.getBounds(), s = scaleOf();
    const inside = (win === overlay && (!!dragTimer || exclusive)) || rectsRef().some(r => p.x >= b.x + r.x * s && p.x <= b.x + (r.x + r.width) * s
      && p.y >= b.y + r.y * s && p.y <= b.y + (r.y + r.height) * s);
    if (inside !== interactive) win.setIgnoreMouseEvents(!(interactive = inside));
  }, 50);
}

// ---------- exclusive mode (as in Overwolf): the overlay takes the mouse, the game is dimmed ----------
// A dim layer over the screen catches clicks and Esc so nothing reaches the game; the overlay stays on top
// and is fully clickable. The same hotkey, Esc or a click on the dim layer goes back to the game.
let exclusive = false, dimWin = null;
function toggleExclusive(force) {
  const on = typeof force === 'boolean' ? force : !exclusive;
  if (process.env.D4_DEBUG) console.log('exclusive ->', on, 'overlay visible', overlay.isVisible(), 'build', !!build);
  if (on && (!overlay.isVisible() || !build)) return;
  exclusive = on;
  if (on) {
    const { bounds } = screen.getDisplayMatching(overlay.getBounds()); // the screen the overlay (and so the game) is on
    if (!dimWin || dimWin.isDestroyed()) {
      dimWin = new BrowserWindow({
        ...bounds, show: false, transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, hasShadow: false,
        webPreferences: { preload: path.join(DIR, 'preload.cjs') },
      });
      dimWin.setAlwaysOnTop(true, 'screen-saver');
      dimWin.loadFile(path.join(DIR, 'overlay.html'), { hash: 'dim' });
    }
    dimWin.setBounds(bounds);
    dimWin.show();
    dimWin.focus(); // receives Esc; the focus watcher ignores our own windows, so the overlay stays visible
    overlay.moveTop();
  } else if (dimWin && !dimWin.isDestroyed()) {
    dimWin.hide(); // Windows hands the focus back to the game window below
  }
  lastSent = '';
  send();
}

function createOverlay() {
  const { workArea } = screen.getPrimaryDisplay();
  // default left side: D4 opens character/inventory panels on the right and the minimap is top-right
  state.window = { x: workArea.x + 20, y: workArea.y + Math.round(workArea.height * 0.15), scale: 1, locked: false, ...state.window };
  overlay = new BrowserWindow({
    x: state.window.x, y: state.window.y, width: BASE.width, height: BASE.height, show: false,
    transparent: true, frame: false, alwaysOnTop: true, focusable: false, skipTaskbar: true, resizable: false, hasShadow: false,
    webPreferences: { preload: path.join(DIR, 'preload.cjs'), backgroundThrottling: false }, // hidden while alt-tabbed: stay ready
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  if (!imageArg) overlay.setContentProtection(true); // best effort only, see ownRects()
  let rects = [];
  ipcMain.on('rects', (e, r) => { if (e.sender === overlay.webContents) rects = Array.isArray(r) ? r : []; });
  watchInteractive(overlay, () => state.window.scale, () => rects);
  overlay.webContents.on('did-finish-load', () => { applyScale(state.window.scale); overlay.setOpacity(settings().overlayOpacity); sendBuild(); });
  overlay.loadFile(path.join(DIR, 'overlay.html'), process.env.D4_TAB ? { query: { tab: process.env.D4_TAB } } : {});
}

// big centered view for the paragon boards; interactive everywhere, closed with its hotkey or button
function toggleDetail() {
  if (detail && !detail.isDestroyed()) return detail.close();
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.round(workArea.width * 0.7), height = Math.round(workArea.height * 0.85);
  detail = new BrowserWindow({
    x: workArea.x + Math.round((workArea.width - width) / 2), y: workArea.y + Math.round((workArea.height - height) / 2), width, height,
    show: false, transparent: true, frame: false, alwaysOnTop: true, focusable: false, skipTaskbar: true, resizable: false, hasShadow: false,
    webPreferences: { preload: path.join(DIR, 'preload.cjs'), backgroundThrottling: false },
  });
  detail.setAlwaysOnTop(true, 'screen-saver');
  if (!imageArg) detail.setContentProtection(true);
  detail.webContents.on('did-finish-load', () => { sendBuild(); updateVisibility(); });
  detail.loadFile(path.join(DIR, 'overlay.html'), { hash: 'detail' });
}

function showControl() {
  if (control && !control.isDestroyed()) return control.show(), control.focus();
  control = new BrowserWindow({
    width: 620, height: 720, title: 'D4 Build Tracker', icon: ICON, autoHideMenuBar: true, backgroundColor: '#14110e',
    webPreferences: { preload: path.join(DIR, 'preload.cjs') },
  });
  control.once('close', () => { if (process.env.D4_DEBUG) console.log('main window closed -> quit'); app.quit(); }); // closing the main window ends the app, overlay included
  if (process.env.D4_CONTROL_JS) control.webContents.once('did-finish-load', () => control.webContents.executeJavaScript(process.env.D4_CONTROL_JS)); // dev: drive the form
  control.loadFile(path.join(DIR, 'control.html'));
}

// ---------- automatic updates from GitHub Releases ----------
// The installed app checks the public repo's releases, downloads a newer version in the background and
// installs it on the next quit, or right away from the main window ("Nu herstarten").
const { autoUpdater } = updaterPkg;
let updateReady = null;
function setupUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.on('update-downloaded', info => {
    updateReady = info.version;
    control?.isDestroyed() || control?.webContents.send('update-ready', updateReady);
    notify(`Update ${updateReady} staat klaar: wordt geïnstalleerd bij afsluiten`, 'ok');
  });
  autoUpdater.on('error', e => console.error('update check failed', e.message));
  const check = () => autoUpdater.checkForUpdates().catch(e => console.error('update check failed', e.message));
  check();
  setInterval(check, 6 * 60 * 60 * 1000);
}

// ---------- hotkeys, tray ----------
function registerHotkeys() {
  globalShortcut.unregisterAll();
  const { hotkeys } = settings();
  const failed = [];
  const reg = (accel, fn) => { try { if (!globalShortcut.register(accel, fn)) failed.push(accel); } catch { failed.push(accel); } };
  reg(hotkeys.overlay, toggleOverlay);
  reg(hotkeys.exclusive, toggleExclusive);
  reg(hotkeys.detail, toggleDetail);
  reg(hotkeys.capture, () => captureScreen().catch(e => console.error('capture failed', e)));
  if (process.env.D4_DEBUG && failed.length) console.log('hotkeys failed', failed);
  return failed;
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('D4 Build Tracker');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Overlay tonen/verbergen (in Diablo IV)', click: toggleOverlay },
    { label: 'Paragon/skills groot', click: toggleDetail },
    { label: 'Builds & instellingen', click: showControl },
    { type: 'separator' },
    { label: 'Afsluiten', click: () => app.quit() },
  ]));
  tray.on('click', showControl);
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.on('drag-start', (_e, mode) => startDrag(/^(scale|resize-(n|s|e|w|ne|nw|se|sw))$/.test(mode) ? mode : 'move'));
  ipcMain.on('drag-end', endDrag);
  ipcMain.on('phase', (_e, name) => {
    if (!phases().some(p => p.name === name)) return;
    buildState().phase = String(name);
    save();
    sendBuild();
  });
  ipcMain.on('open-control', showControl);
  ipcMain.handle('reset-progress', async () => {
    buildState().seen = {};
    buildState().equipped = {};
    await save();
    lastSent = '';
    send();
  });
  ipcMain.handle('open-debug', () => shell.openPath(path.join(app.getPath('userData'), 'debug')));
  ipcMain.on('toggle-detail', toggleDetail);
  ipcMain.on('exclusive-off', () => toggleExclusive(false));

  ipcMain.handle('install-update', () => updateReady && autoUpdater.quitAndInstall());
  ipcMain.handle('library', async () => ({ version: app.getVersion(), updateReady, builds: await lib.list(), active: state.activeBuild, phase: phase()?.name ?? null, phases: phases().map(p => p.name), settings: settings(), window: state.window }));
  ipcMain.handle('import', async (_e, link) => {
    const imported = await lib.import(String(link ?? '').slice(0, 2000));
    state = await lib.state();
    await loadActiveBuild();
    return { name: imported.name, phases: imported.phases.length };
  });
  ipcMain.handle('activate', async (_e, id) => {
    if (!(await lib.list()).some(b => b.id === id)) return;
    state.activeBuild = id;
    await save();
    await loadActiveBuild();
  });
  ipcMain.handle('remove', async (_e, id) => {
    await lib.remove(String(id));
    state = await lib.state();
    await loadActiveBuild();
  });
  ipcMain.handle('settings', async (_e, change) => {
    const next = { ...settings(), ...change, hotkeys: { ...settings().hotkeys, ...change?.hotkeys } };
    const clamp = (v, lo, fallback) => Math.min(1, Math.max(lo, Number.isFinite(Number(v)) ? Number(v) : fallback));
    next.opacity = clamp(next.opacity, 0, DEFAULT_SETTINGS.opacity); // panel background only
    next.overlayOpacity = clamp(next.overlayOpacity, 0.3, 1); // the whole overlay, text included
    next.ocr = !!next.ocr;
    next.notify = !!next.notify;
    overlay.setOpacity(next.overlayOpacity);
    setTimeout(updateVisibility); // OCR on/off starts or stops the screen stream
    delete next.locked; delete next.resetWindow; // window state, not settings
    state.settings = next;
    if (typeof change?.locked === 'boolean') state.window.locked = change.locked;
    if (change?.resetWindow) { delete state.window; createOverlayPosition(); }
    const failed = registerHotkeys();
    await save();
    lastSent = '';
    send();
    return { failed };
  });
}

function createOverlayPosition() {
  const { workArea } = screen.getPrimaryDisplay();
  state.window = { x: workArea.x + 20, y: workArea.y + Math.round(workArea.height * 0.15), scale: 1, locked: false };
  applyScale(1, [state.window.x, state.window.y], BASE.height);
}

app.whenReady().then(async () => {
  state = await lib.state();
  if (!app.isPackaged && !process.env.D4_USER_DATA) await lib.migrate(DIR); // dev: take over the old build.json/progress.json once
  state = await lib.state();
  build = state.activeBuild ? await lib.get(state.activeBuild) : null;

  registerIpc();
  createOverlay();
  createTray();
  registerHotkeys();
  if (!imageArg) showControl(); // the main window is "the app": closing it quits
  updateVisibility();
  upgradeBuild();
  setupUpdates();

  // dev check without photographing the desktop: write PNGs of our own windows only
  if (process.env.D4_DETAIL) toggleDetail();
  if (process.env.D4_EXCLUSIVE) setTimeout(() => toggleExclusive(true), 3000); // dev: test the exclusive mode
  if (process.env.D4_SNAPSHOT_DIR) setInterval(async () => {
    for (const [name, w] of [['overlay', overlay], ['detail', detail], ['control', control], ['toast', toast], ['dim', dimWin]]) {
      if (w && !w.isDestroyed() && w.isVisible()) await writeFile(path.join(process.env.D4_SNAPSHOT_DIR, `${name}.png`), (await w.webContents.capturePage()).toPNG());
    }
  }, 1500);

  for (let n = 0; ; n++) {
    try {
      const active = (gameRunning || !!imageArg) && settings().ocr;
      if (active && !imageArg && n % 12 === 0) await detectContext(); // every ~3 s
      else if (active && !imageArg && n % 12 === 6) await detectLevelUp();
      else if (!active && context) { context = null; }
      if (active) await tick(); else send();
    } catch (e) {
      console.error('tick failed:', e.message);
    }
    await new Promise(r => setTimeout(r, PERIOD_MS));
  }
});

app.on('second-instance', showControl);
app.on('window-all-closed', () => {}); // the overlay windows are never "all closed"; quitting goes via the main window or tray
app.on('will-quit', () => {
  if (process.env.D4_DEBUG) console.log('will-quit'); globalShortcut.unregisterAll(); ocrProc.kill(); focusProc.kill(); });
