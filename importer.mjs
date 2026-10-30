// Import a Maxroll D4 build guide (or planner link/ID) into build.json for the tracker.
// Usage: node importer.mjs <guide-url | planner-url | planner-id> [out.json]
// shortcut: uses Maxroll's undocumented planner/game-data JSON, personal use only; update if their format changes.
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const GAME = 'https://assets-ng.maxroll.gg/d4-tools/game';
export const profileUrl = id => `https://planners.maxroll.gg/profiles/load/d4/${id}`;

async function fetchOk(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res;
}
export const getJson = async url => (await fetchOk(url)).json();
export const getText = async url => (await fetchOk(url)).text();

// Only Maxroll D4 pages are fetched: the pasted text is untrusted input.
export async function resolveProfileId(input, fetchText = getText) {
  const text = String(input ?? '').trim();
  if (/^[a-z0-9]{6,12}$/i.test(text)) return text;
  let url;
  try { url = new URL(text); } catch { throw new Error('Plak een Maxroll-link (https://maxroll.gg/d4/...) of planner-ID.'); }
  if (url.protocol !== 'https:' || !/^(www\.)?maxroll\.gg$/i.test(url.hostname) || !url.pathname.startsWith('/d4/')) {
    throw new Error('Alleen links van https://maxroll.gg/d4/ worden ondersteund.');
  }
  const planner = url.pathname.match(/^\/d4\/planner\/([a-z0-9]+)/i);
  if (planner) return planner[1];
  const ids = [...(await fetchText(url.href)).matchAll(/data-d4-profile="([a-z0-9]+)"/gi)].map(m => m[1]);
  if (!ids.length) throw new Error('Geen build-planner gevonden op die pagina.');
  return ids[0];
}

// Turns a Maxroll text template into tooltip-like text, e.g. "+[{value}||] Maximum Life" -> "+1500 Maximum Life".
export function render(template, values = [], paramName = '') {
  const num = (expr, fmt) => {
    const affixN = /Affix_Value_(\d)/.exec(expr)?.[1];
    let v = affixN ? values[affixN - 1] : expr.includes('value2') ? values[1] ?? values[0] : values[0];
    if (v === undefined) return '#';
    if (expr.includes('*100')) v *= 100;
    v = Math.round(v * 10) / 10;
    return fmt.includes('%') ? `${v}%` : `${v}`;
  };
  return template
    .replace(/\{if:[^}]*\}(?:(?!\{\/if\})[\s\S])*?\{else\}([\s\S]*?)\{\/if\}/gi, '$1')
    .replace(/\{if:[^}]*\}|\{\/if\}/gi, '')
    .replace(/\{\/?(c(_[a-z_]+)?|u|b)\}|\{icon:[^}]*\}|\\\[\+\\\]/gi, '')
    .replace(/\[([^|\]]*)\|([^|\]]*)\|[^\]]*\]/g, (_, expr, fmt) => num(expr, fmt))
    .replace(/\{value1\}/g, paramName || '{value1}')
    .replace(/\{value2?\}/g, () => num('{value2}', ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function makeLookup(min, en) {
  const affixKeyById = {};
  for (const [key, a] of Object.entries(min.affixes)) affixKeyById[a.id] = key;
  // some attribute names differ only in case from their description key (e.g. Flat_Hitpoints_On_Hit vs _on_Hit)
  const descByLower = {};
  for (const [name, tpl] of Object.entries(en.attributeDescriptions)) descByLower[name.toLowerCase()] = tpl;
  const skillNameById = {};
  for (const [key, s] of Object.entries(min.skills)) skillNameById[s.id] = en.skills[key]?.name;

  const paramName = (attr, param) => {
    const type = min.attributes[attr.id]?.paramType;
    if (type === 5) return skillNameById[param] ?? '';
    if (type === 7) return en.uiStrings.resourceType?.[param] ?? '';
    if (type === 0) return en.uiStrings.damageType?.[param] ?? '';
    return '';
  };

  return function affixText({ nid, values = [] }) {
    const key = affixKeyById[nid];
    if (!key) return { nid, key: null, text: `unknown affix ${nid}`, values };
    if (en.affixes[key]?.desc) return { nid, key, text: render(en.affixes[key].desc, values), values };
    const attr = min.affixes[key].attributes?.[0];
    const attrName = attr && min.attributes[attr.id]?.name;
    const tpl = attrName && (en.attributeDescriptions[attrName] ?? descByLower[attrName.toLowerCase()]);
    // e.g. SkillRankBonus_Barb_Category_Brawling -> "Brawling" when the param is a hashed category
    const param = paramName(attr, attr.param) || key.split('_').pop();
    const text = tpl ? render(tpl, values, param) : (attrName ?? key).replace(/_/g, ' ');
    return { nid, key, text, values };
  };
}

const SKILL_KINDS = ['skill', 'upgrade', 'passive']; // skillTreeRewards.type 0/1/2

// skill tree node ids are only unique within one class tree (keys like "Barbarian", "Paladin_NEW")
function classTree(min, classIndex) {
  const name = min.classes?.[classIndex]?.name;
  const keys = Object.keys(min.skillTrees ?? {});
  const key = keys.find(k => k === name) ?? keys.find(k => name && k.startsWith(name));
  const nodeById = {};
  for (const n of min.skillTrees?.[key]?.nodes ?? []) nodeById[n.id] = n;
  return nodeById;
}

function makeSkills(min, en) {
  const trees = {};
  let nodeById = {};
  const nameOf = key => en.skills[key]?.name ?? key.replace(/_/g, ' ');
  const node = (id, rank) => {
    const n = nodeById[id];
    const reward = n && min.skillTreeRewards?.[n.rewardId];
    if (!reward) return { id: Number(id), rank, kind: 'unknown', name: `node ${id}` };
    let name = nameOf(reward.power);
    if (reward.type === 1) {
      const i = (min.skills[reward.power]?.mods ?? []).findIndex(m => m.id === reward.mod);
      name = `${name}: ${en.skills[reward.power]?.mods?.[i]?.name ?? 'upgrade'}`;
    }
    return { id: Number(id), rank, maxRank: reward.ranks, kind: SKILL_KINDS[reward.type] ?? 'unknown', name, level: n.requiredLevel ?? 1 };
  };
  const byOrder = (a, b) => SKILL_KINDS.indexOf(a.kind) - SKILL_KINDS.indexOf(b.kind) || a.level - b.level || a.name.localeCompare(b.name);
  return p => (nodeById = trees[p.class] ??= classTree(min, p.class), {
    bar: (p.skillBar ?? []).filter(Boolean).map(nameOf),
    steps: (p.skillTree?.steps ?? []).map(s => ({
      name: s.name,
      nodes: Object.entries(s.data ?? {}).filter(([, r]) => r > 0).map(([id, r]) => node(id, r)).sort(byOrder),
    })),
    technique: p.technique ? nameOf(p.technique) : null,
  });
}

// cell codes for a 21x21 board: . empty, n normal, m magic, r rare, l legendary, g gate, s glyph socket
export function cellCode(key, rarity) {
  if (!key) return '.';
  if (key === 'Generic_Gate') return 'g';
  if (/Socket|_Glyph$/.test(key)) return 's';
  return { 0: 'n', 2: 'm', 3: 'r', 4: 'l' }[rarity] ?? 'n';
}

function makeParagon(min, en) {
  const board = b => {
    const layout = min.paragonBoards?.[b.id];
    if (!layout) return { id: b.id, name: b.id, missing: true };
    const labels = {};
    const cells = layout.nodes.map((key, i) => {
      const code = cellCode(key, min.paragonNodes[key]?.rarity);
      if ('rls'.includes(code) && key) labels[i] = en.paragonNodes[key]?.name ?? key.replace(/_/g, ' ');
      return code;
    }).join('');
    return {
      id: b.id,
      name: en.paragonBoards[b.id]?.name ?? b.id,
      width: layout.width,
      rotation: b.rotation ?? 0, // quarter turns clockwise
      position: b.position ?? { x: 0, y: 0 },
      glyph: b.glyph ? { name: en.paragonGlyphs[b.glyph]?.name ?? b.glyph, level: b.glyphLevel ?? 1 } : null,
      cells,
      selected: Object.keys(b.nodes ?? {}).filter(k => b.nodes[k]).map(Number).sort((x, y) => x - y),
      labels,
    };
  };
  return p => ({ steps: (p.paragon?.steps ?? []).map(s => ({ name: s.name, boards: (s.data ?? []).map(board) })) });
}

export function buildFromProfile(profile, min, en) {
  const data = typeof profile.data === 'string' ? JSON.parse(profile.data) : profile.data;
  const affixText = makeLookup(min, en);
  const skillsOf = makeSkills(min, en);
  const paragonOf = makeParagon(min, en);
  const phases = data.profiles.map(p => {
    const slots = {};
    for (const itemRef of Object.values(p.items ?? {})) {
      const it = data.items[itemRef];
      if (!it) continue;
      const type = min.items[it.id]?.type ?? it.id.split('_')[0];
      let slot = type;
      for (let n = 2; slots[slot]; n++) slot = `${type} ${n}`; // Ring, Ring 2
      slots[slot] = {
        itemId: it.id,
        unique: /_Unique_/.test(it.id),
        name: en.items[it.id]?.name ?? it.name ?? null,
        aspects: (it.aspects ?? []).map(affixText),
        affixes: (it.explicits ?? []).map(a => ({ ...affixText(a), greater: !!a.greater })),
        implicits: (it.implicits ?? []).map(affixText),
        tempered: (it.tempered ?? []).map(affixText),
        sockets: (it.sockets ?? []).filter(Boolean),
      };
    }
    const merc = p.mercenary?.id ? {
      name: en.mercenaries?.[p.mercenary.id]?.name ?? p.mercenary.id,
      support: p.mercenary.support ? en.mercenaries?.[p.mercenary.support]?.name ?? p.mercenary.support : null,
    } : null;
    return {
      name: p.name,
      class: en.classes?.[p.class]?.nameMale ?? null,
      level: p.level,
      slots,
      skills: skillsOf(p),
      paragon: paragonOf(p),
      mercenary: merc,
    };
  });
  return { source: `maxroll:${profile.id}`, name: profile.name, season: data.season ?? null, importedAt: new Date().toISOString(), phases };
}

async function main([input, out = 'build.json']) {
  if (!input) throw new Error('Usage: node importer.mjs <guide-url | planner-url | planner-id> [out.json]');
  const id = await resolveProfileId(input);
  const [profile, min, en] = await Promise.all([
    getJson(profileUrl(id)),
    getJson(`${GAME}/data.min.json`),
    getJson(`${GAME}/data.enus.json`),
  ]);
  const build = buildFromProfile(profile, min, en);
  await writeFile(out, JSON.stringify(build, null, 2));

  console.log(`${build.name} (${build.source}) -> ${out}`);
  for (const ph of build.phases) {
    const slots = Object.entries(ph.slots);
    if (!slots.length) continue;
    console.log(`\n== ${ph.name} ==`);
    for (const [slot, s] of slots) {
      const what = s.unique ? `UNIQUE ${s.name}` : s.aspects.map(a => a.text).join(' / ') || s.name;
      console.log(`  ${slot.padEnd(10)} ${what}`);
      for (const a of s.affixes) console.log(`  ${''.padEnd(10)}   - ${a.text}${a.greater ? ' (GA)' : ''}`);
      for (const a of s.tempered) console.log(`  ${''.padEnd(10)}   ~ ${a.text}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exit(1); });
}
