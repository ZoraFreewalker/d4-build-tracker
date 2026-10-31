// Read D4 tooltips from a screenshot (Windows OCR) and compare them with a phase of build.json.
// Usage: node tracker.mjs <image> [phase name] [build.json]
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OCR_SCRIPT = fileURLToPath(new URL('./ocr.ps1', import.meta.url));

export function readOcr(imagePath) {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', OCR_SCRIPT, imagePath], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`OCR failed: ${r.stderr.trim()}`);
  // D4 bullet glyphs come out as control characters
  return JSON.parse(r.stdout.replace(/[\u0000-\u001f]/g, ' '));
}

const TYPE_LINE = /^(?:(ancestral|sacred)\s+)?(common|magic|rare|legendary|unique|mythic)\s+(?:unique\s+)?([a-z][a-z -]{1,30})$/i;
const MAX_AFFIXES = 4;
const STOP = new Set(['to', 'of', 'the', 'a', 'an', 'for', 'and', 'x', 'per', 'by', 'you', 'your', 'o', 'multiplier']);

export const words = s => s.toLowerCase()
  .replace(/\[[^\]\s]*\]?/g, ' ') // value ranges, OCR often reads "]" as "1"
  .replace(/[^a-z' ]+/g, ' ')
  .split(/\s+/)
  .filter(w => w.length > 1 && !STOP.has(w));

// "Two-Handed Axe" -> "Axe2H", "Chest Armor" -> "ChestArmor", "Pants" -> "Legs" (Maxroll's item types)
export function slotType(type) {
  const t = type.replace(/[^a-z ]/gi, ' ').trim().replace(/\s+/g, ' ');
  const two = /^two handed (.+)$/i.exec(t);
  const base = (two ? two[1] : t).split(' ').map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join('');
  return base === 'Pants' ? 'Legs' : two ? `${base}2H` : base;
}

const num = s => Number(String(s).replace(/,(?=\d{3}\b)/g, '').replace(',', '.'));

// "760+25 Item Power" -> 785, "500 Item Power" -> 500
export function itemPower(text) {
  const m = /(\d[\d,]*)\s*(?:\+\s*(\d+))?\s*item power/i.exec(text);
  return m ? num(m[1]) + (m[2] ? num(m[2]) : 0) : null;
}

// The game compares a hovered item with the equipped one itself: "19 Armor (-21.5% Toughness)",
// "(+12% Damage)". A missing sign (OCR) means unknown, so it is left out.
export function gameDeltas(text) {
  const out = {};
  for (const m of text.matchAll(/\(\s*([+\-−–])\s*(\d+(?:[.,]\d+)?)\s*%\s*(toughness|damage)/gi)) {
    out[m[3].toLowerCase()] = (m[1] === '+' ? 1 : -1) * num(m[2]);
  }
  // weapons show an absolute DPS difference: "27 Damage Per Second (+1)" -> +1 on the equipped 26 = +3.8%
  const dps = /(\d[\d,]*)\s*damage per second\s*\(\s*([+\-−–])\s*(\d+(?:[.,]\d+)?)\s*\)/i.exec(text);
  if (dps && out.damage === undefined) {
    const diff = (dps[2] === '+' ? 1 : -1) * num(dps[3]);
    const equippedDps = num(dps[1]) - diff;
    if (equippedDps > 0) { out.damage = Math.round((diff / equippedDps) * 1000) / 10; out.dpsOnly = true; }
  }
  return out;
}

// value of a build affix in tooltip text: the last number before its first words, e.g. "+30 Strength" -> 30
export function affixValue(body, affixText) {
  const w = words(affixText).slice(0, 2);
  if (!w.length) return null;
  // small words like "to" are dropped by words(), so allow one extra word between the kept ones
  const m = new RegExp(`\\b${w.join('\\W+(?:\\w+\\W+)?')}`, 'i').exec(body);
  if (!m) return null;
  const nums = body.slice(Math.max(0, m.index - 30), m.index).match(/\d[\d,]*(?:\.\d+)?/g);
  return nums ? num(nums.at(-1)) : null;
}

// Tooltip rows -> one entry per affix with the game's own difference: "+2 Strength +[1 - 7] (+2)" ->
// { text: '+2 Strength', delta: '+2' }. Wrapped rows ("2.0]% (+1.3%)") are joined to the affix above.
const BASE_ROW = /item power|damage per second|damage per hit|attacks per second|^upgrades|quality$|^[\d,.]+\s+(armor|all resist)\b/i;
const NEW_AFFIX = /^[+\-x×]?\d[\d,.]*%?\s+[a-z]/i;
// Rows may carry x/h: wrapped lines are indented past the bullets, which separates them from new affixes.
export function affixEntries(rows) {
  const items = rows.map(r => (typeof r === 'string' ? { text: r } : r));
  const bulletX = Math.min(...items.filter(r => r.x != null).map(r => r.x), Infinity);
  const entries = [];
  for (const { text: raw, x, h = 20 } of items) {
    if (/\(\d+\s*\/\s*\d+\)/.test(raw)) break; // rune/socket block ("(50/300)") follows the affixes
    const bullet = /^[o0*•◆·]\s+/i.test(raw) || (x != null && x <= bulletX + h * 0.5);
    const row = raw.replace(/^[o0*•◆·]\s+/i, '').trim();
    if (!row || BASE_ROW.test(row)) continue;
    const prev = entries.at(-1);
    const sentenceDone = prev && /[.%\])]$/.test(prev.raw) && /^[A-Z]/.test(row);
    if (prev && !bullet && !NEW_AFFIX.test(row) && !sentenceDone) prev.raw += ` ${row}`;
    else entries.push({ raw: row });
  }
  return entries.map(({ raw }) => {
    const delta = /\(\s*([+\-−–]\s*\d[\d,.]*%?)\s*\)\s*$/.exec(raw)?.[1].replace(/\s/g, '').replace(/[−–]/, '-') ?? null;
    // a short "(…)" that isn't a readable difference: the red/green value was there but OCR mangled it ("(A)")
    const unreadable = !delta && /\(\s*[^()]{1,4}\s*\)\s*$/.test(raw);
    const text = raw.replace(/\(\s*[+\-−–]\s*\d[\d,.]*%?\s*\)\s*$/, '').replace(/\(\s*[^()]{1,4}\s*\)\s*$/, '')
      .replace(/\+?\s*\[[^\]]*\]?\s*%?/g, ' ')
      // value ranges whose brackets OCR read as "1" or dropped: "+[1 - 7]" -> "+11 - 71" / "- 71"
      .replace(/\s\+?\d*[\d.,]*\s*[-–]\s*\d[\d.,]*\]?%?(?=\s|$)/g, ' ')
      // a single-value range "+[1]" read as "+111" after the stat name
      .replace(/(?<=[a-z])\s+\+\d[\d.,]*%?(?=\s|$)/gi, ' ')
      .replace(/\s+/g, ' ').trim();
    return unreadable ? { text, delta, unreadable } : { text, delta };
  }).filter(e => e.text.length > 2);
}

// tooltip text from these lines on is not about the item's stats (footer, flavor text)
const TOOLTIP_END = /^(sell value|durability|requires level|account bound|unequip|equip$|mark as|drops from|right click|empty socket|properties lost|compare other slot|["“'])/i;
// weapon type lines carry the damage kind: "Magic Mace (Bludgeoning)" -> "Magic Mace"
const typeText = l => l.text.trim().replace(/\s*\([^)]*\)?\s*$/, '');

export function parseTooltips(lines) {
  // " of " skips non-gear like "Magic Tribute of Growth"
  const heads = lines.map(l => ({ l, m: TYPE_LINE.exec(typeText(l)) })).filter(h => h.m && !/\bof\b/i.test(h.m[3]));
  // common items have no rarity word: the bare type ("Boots") sits right above "10 Item Power"
  for (const power of lines.filter(l => /^\d[\d,+]* item power/i.test(l.text.trim()))) {
    const near = l => Math.abs(l.x - power.x) < 15 && l.y < power.y && l.y > power.y - power.h * 4;
    if (heads.some(h => near(h.l))) continue;
    const above = lines.filter(l => near(l) && l.y > power.y - power.h * 2.5).sort((a, b) => b.y - a.y)[0];
    if (above && /^[a-z][a-z -]{1,30}$/i.test(typeText(above))) heads.push({ l: above, m: [above.text, undefined, 'common', typeText(above)] });
  }
  return heads.map(({ l: head, m }) => {
    // a tooltip is the column of lines starting near the type line's x, up to the next tooltip column
    const nextX = Math.min(...heads.map(h => h.l.x).filter(x => x > head.x + 150), Infinity);
    // name lines overlap the type line horizontally; that also catches centered headers (Legendary Aspect)
    // only lines stacked directly above each other: other UI higher up ("Toughness") is not part of the name
    const nameLines = [];
    for (const l of lines
      .filter(l => l.y < head.y && l.y > head.y - head.h * 9 && l.x < head.x + head.w && l.x + l.w > head.x && !/equipped/i.test(l.text))
      .sort((a, b) => b.y - a.y)) {
      if ((nameLines[0]?.y ?? head.y) - l.y > Math.max(head.h, l.h) * 2.6) break; // name font is taller than the type line
      nameLines.unshift(l);
    }
    const left = Math.min(head.x, ...nameLines.map(l => l.x)) - 45;
    // tooltip lines all start near its left edge; text further right belongs to other UI (character panel)
    const right = Math.min(nextX - 45, left + 45 + head.h * 8);
    const col = lines.filter(l => l.x >= left && l.x < right).sort((a, b) => a.y - b.y);
    let body = col.filter(l => l.y > head.y);
    // footer lines like "Sell Value" are right-aligned, so look for them across the full column width
    const endY = Math.min(...lines.filter(l => l.y > head.y && l.x >= left && l.x < nextX - 45 && TOOLTIP_END.test(l.text.trim())).map(l => l.y), Infinity);
    body = body.filter(l => l.y < endY);
    let type = m[3].trim();
    // "Ancestral Mythic Unique" wraps, the item type is on the next line
    if (/^unique$/i.test(type) && body.length) [type, body] = [body[0].text.trim(), body.slice(1)];
    // the base stat line ("19 Armor (-21.5% Toughness)") can split into fragments that reach past `right`
    const firstRows = body.slice(0, 5).map(l => l.y);
    const top = lines.filter(l => l.x >= left && l.x < nextX - 45 && firstRows.some(y => Math.abs(l.y - y) < head.h))
      .sort((a, b) => a.y - b.y || a.x - b.x).map(l => l.text).join(' ');
    // full rows (colored deltas like "(+2)" can be separate OCR fragments to the right)
    const rows = (y0, y1) => {
      const inRange = lines.filter(l => l.x >= left && l.x < nextX - 45 && l.y > y0 && l.y < y1).sort((a, b) => a.y - b.y || a.x - b.x);
      const out = [];
      for (const l of inRange) {
        const row = out.at(-1);
        if (row && Math.abs(row.y - l.y) < head.h * 0.6) row.text += ` ${l.text}`; else out.push({ y: l.y, x: l.x, h: head.h, text: l.text });
      }
      return out.map(r => ({ ...r, text: r.text.trim() }));
    };
    const lostAt = lines.find(l => l.y > head.y && l.x >= left && l.x < nextX - 45 && /^properties lost/i.test(l.text.trim()));
    const lostEnd = Math.min(...lines.filter(l => lostAt && l.y > lostAt.y && l.x >= left && l.x < nextX - 45
      && TOOLTIP_END.test(l.text.trim()) && !/^properties lost/i.test(l.text.trim())).map(l => l.y), Infinity);
    return {
      affixLines: affixEntries(rows(body[0] ? body[0].y - 1 : head.y, endY)),
      lost: lostAt ? affixEntries(rows(lostAt.y, lostEnd)).map(a => a.text) : [],
      name: nameLines.map(l => l.text).join(' ').replace(/[^a-z' -]/gi, ' ').replace(/\s+/g, ' ').trim(),
      rarity: m[2].toLowerCase(),
      ancestral: !!m[1],
      type,
      slotType: slotType(type),
      equipped: col.some(l => /^equipped$/i.test(l.text.trim()) && l.y < head.y),
      power: itemPower(top),
      deltas: gameDeltas(top),
      // the base stat ("8 Armor", "19 Armor (-21.5% Toughness)", "92 All Resist") has no "+" and is not an affix
      body: body.filter(l => !/^[\d,.]+\s+(armor|all resist)\b/i.test(l.text.trim())).map(l => l.text).join(' '),
    };
  });
}

function similar(a, b) {
  const x = words(a).join(''), y = words(b).join('');
  if (!x || !y) return false;
  const d = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    let prev = d[0]++;
    for (let j = 1; j <= y.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (x[i - 1] === y[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return 1 - d[y.length] / Math.max(x.length, y.length) >= 0.8;
}

// phrase match for short affixes, word coverage for long aspect/unique texts (tolerates OCR typos)
export function hasText(body, text) {
  const want = words(text), have = words(body);
  if (!want.length) return false;
  if (want.length <= 6) return ` ${have.join(' ')} `.includes(` ${want.join(' ')} `);
  const set = new Set(have);
  return want.filter(w => set.has(w)).length / want.length >= 0.8;
}

// how many times a short affix phrase occurs in the tooltip (long aspect texts: 0 or 1)
export function countText(body, text) {
  const want = words(text);
  if (want.length > 6) return hasText(body, text) ? 1 : 0;
  if (!want.length) return 0;
  // whole-word phrase; lookarounds so back-to-back repeats ("maximum life maximum life") both count
  return (words(body).join(' ').match(new RegExp(`(?<=^| )${want.join(' ')}(?= |$)`, 'g')) ?? []).length;
}

// slots that take the same kind of weapon (e.g. the Barbarian arsenal: any 1H weapon fits a dual-wield slot)
const WEAPON_ROLE = {
  Axe: '1h', Sword: '1h', Mace: '1h', Flail: '1h', Dagger: '1h', Scythe: '1h', Wand: '1h',
  Axe2H: '2h-slash', Sword2H: '2h-slash', Polearm: '2h-slash', Scythe2H: '2h-slash', Glaive: '2h-slash',
  Mace2H: '2h-blunt', Quarterstaff: '2h-blunt',
  Staff: 'staff', StaffDruid: 'staff', StaffSorcerer: 'staff',
  Bow: 'ranged', Crossbow: 'ranged', Crossbow2H: 'ranged',
  Shield: 'shield', ShieldHTH: 'shield', Focus: 'focus', FocusBookOffHand: 'focus', Totem: 'totem', OffHandTotem: 'totem',
};
export const sameSlot = (a, b) => a === b || (!!WEAPON_ROLE[a] && WEAPON_ROLE[a] === WEAPON_ROLE[b]);

export function compare(tooltip, phase) {
  // a loose aspect (drop or Codex of Power): which slots of this phase use it
  if (tooltip.slotType === 'Aspect') {
    const slots = Object.entries(phase.slots).filter(([, s]) => s.aspects.some(a => hasText(tooltip.body, a.text))).map(([slot]) => slot);
    return slots.length ? { slot: slots.join(', '), want: tooltip.name, item: true, affixes: [], score: 100 } : null;
  }
  const candidates = Object.entries(phase.slots).filter(([slot]) => sameSlot(slot.replace(/ \d+$/, ''), tooltip.slotType));
  const results = candidates.map(([slot, s]) => {
    const item = s.unique
      ? similar(tooltip.name, s.name ?? '')
      : s.aspects.length ? s.aspects.some(a => hasText(tooltip.body, a.text)) : null;
    // one tooltip line satisfies one build affix: "+1 Maximum Life" can't count as both the affix and the
    // "+1500 Maximum Life" temper. Regular affixes go first, a temper needs a line of its own.
    const used = {};
    const take = text => {
      const key = words(text).join(' ');
      if (countText(tooltip.body, text) <= (used[key] ?? 0)) return false;
      used[key] = (used[key] ?? 0) + 1;
      return true;
    };
    const affixes = [...s.affixes, ...s.tempered.map(a => ({ ...a, tempered: true }))]
      .map(a => ({ text: a.text, tempered: !!a.tempered, priority: a.priority ?? null, ok: take(a.text) }));
    // Maxroll lists more affixes than fit on a non-unique item (max 4), so cap both counts at 4
    const cap = n => Math.min(n, MAX_AFFIXES);
    const regular = affixes.filter(a => !a.tempered), tempered = affixes.filter(a => a.tempered);
    const got = cap(regular.filter(a => a.ok).length) + tempered.filter(a => a.ok).length + (item ? 1 : 0);
    const total = cap(regular.length) + tempered.length + (item === null ? 0 : 1);
    // a unique's affixes are fixed and Maxroll sometimes lists ones the game version lacks, so the name decides
    const score = s.unique ? (item ? 100 : 0) : total ? Math.round((got / total) * 100) : 0;
    return { slot, want: s.unique ? `UNIQUE ${s.name}` : s.aspects.map(a => a.text).join(' / ') || s.name, item, affixes, score };
  });
  return results.sort((a, b) => b.score - a.score)[0] ?? null;
}

// seen: { slotType: { itemName: score } } from equipped tooltips; best items fill same-type slots (Ring, Ring 2)
export function progress(phase, seen = {}) {
  const slots = Object.keys(phase.slots).map(slot => ({ slot, type: slot.replace(/ \d+$/, ''), score: 0, item: null }));
  for (const [type, items] of Object.entries(seen)) {
    const best = Object.entries(items).sort((a, b) => b[1] - a[1]);
    slots.filter(s => s.type === type).forEach((s, i) => { if (best[i]) [s.item, s.score] = best[i]; });
  }
  const percent = slots.length ? Math.round(slots.reduce((n, s) => n + s.score, 0) / slots.length) : 0;
  const next = [...slots].sort((a, b) => a.score - b.score)[0] ?? null;
  return { percent, slots, next };
}

async function main([image, phaseName, buildPath = fileURLToPath(new URL('./build.json', import.meta.url))]) {
  if (!image) throw new Error('Usage: node tracker.mjs <image> [phase name] [build.json]');
  const build = JSON.parse(await readFile(buildPath, 'utf8'));
  const phase = build.phases.find(p => p.name.toLowerCase() === (phaseName ?? '').toLowerCase()) ?? build.phases[0];
  console.log(`Build: ${build.name} / fase: ${phase.name}`);
  const tooltips = parseTooltips(readOcr(image));
  if (!tooltips.length) console.log('Geen item-tooltip gevonden.');
  for (const t of tooltips) {
    console.log(`\n${t.equipped ? '[EQUIPPED] ' : ''}${t.name || '?'} — ${t.ancestral ? 'Ancestral ' : ''}${t.rarity} ${t.type} (slot ${t.slotType})`);
    const r = compare(t, phase);
    if (!r) { console.log('  Slot zit niet in deze fase van je build.'); continue; }
    console.log(`  Build-slot ${r.slot}: ${r.want.slice(0, 90)}`);
    console.log(`  Item/aspect: ${r.item === null ? 'n.v.t.' : r.item ? 'JA' : 'nee'}   Match: ${r.score}%`);
    for (const a of r.affixes) console.log(`   ${a.ok ? '✓' : '·'} ${a.tempered ? '(temper) ' : ''}${a.text.slice(0, 80)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exit(1); });
}

// drops OCR lines whose center lies inside one of the rects (our own overlay windows)
export const outside = (lines, rects) => lines.filter(l => !rects.some(r =>
  l.x + l.w / 2 >= r.x && l.x + l.w / 2 <= r.x + r.width && l.y + l.h / 2 >= r.y && l.y + l.h / 2 <= r.y + r.height));

// Which in-game screen is open, from OCR of the right side of the screen. The ABILITIES panel shows the tabs
// "Skill Tree" and "Paragon (Lv. 70)" in both modes; only the skill tree has "Available Points"/"Skill Assignment".
export function screenContext(lines) {
  const has = re => lines.some(l => re.test(l.text.trim()));
  if (!has(/^skill tree$/i) || !has(/^paragon\b/i)) return null;
  return has(/available points|skill assignment|respec mode/i) ? 'skills' : 'paragon';
}

// Is the hovered item an upgrade over the equipped one? Weighs the game's own figures (damage/toughness delta,
// per-stat "(+2)"/"(-1)" and "Properties lost when equipped"), build stats by their guide priority, and item
// power. Returns kind + reasons + the item's stats grouped as better / lower / equal / lost.
const PRIORITY_WEIGHT = { 1: 1.5, 2: 1.2, 3: 0.9 }; // 4+ and unranked build stats: 0.6, temper 0.9
function statWeight(stat) {
  if (stat.tempered) return 0.9;
  if (stat.build) return PRIORITY_WEIGHT[stat.priority] ?? (stat.priority ? 0.6 : 0.9);
  return /^x\d/i.test(stat.text) ? 0.8 : 0.4; // multiplicative damage is strong even outside the build
}
const statName = s => `${s.build && s.priority ? `${'①②③④⑤⑥⑦⑧⑨'[s.priority - 1] ?? s.priority} ` : ''}${s.text.replace(/^[+x]?[\d.,]+%?\s+/i, '')}`;

export function verdict(hovered, equipped, phase) {
  const pos = [], neg = [];
  let total = 0;
  const add = (value, text) => {
    if (!value) return;
    total += value;
    (value > 0 ? pos : neg).push(text);
  };
  const pct = v => `${v > 0 ? '+' : ''}${Math.round(v * 10) / 10}%`;
  const { damage, toughness, dpsOnly } = hovered.deltas ?? {};
  // a weapon's DPS delta only covers the weapon itself, not the stats it adds or removes
  if (damage !== undefined) add(Math.sign(damage) * (dpsOnly ? 1 : 2), `${pct(damage)} ${dpsOnly ? 'wapen-DPS' : 'damage'}`);
  if (toughness !== undefined) add(Math.sign(toughness), `${pct(toughness)} toughness`);

  // the item's stats, marked when the build uses them (with the guide's priority)
  const h = compare(hovered, phase);
  const slot = h && phase.slots[h.slot.split(', ')[0]];
  const wanted = slot ? [...slot.affixes, ...slot.tempered.map(a => ({ ...a, tempered: true })), ...slot.aspects] : [];
  const mark = text => { const w = wanted.find(b => countText(text, b.text) > 0); return { build: !!w, priority: w?.priority ?? null, tempered: !!w?.tempered }; };
  const stats = (hovered.affixLines ?? []).map(a => ({ ...a, ...mark(a.text) }));
  // no readable difference from the game: compare with the same stat on the equipped item ourselves
  for (const a of stats.filter(a => !a.delta && equipped)) {
    const own = num(/^[+x]?(\d[\d.,]*)/i.exec(a.text)?.[1] ?? NaN), other = affixValue(equipped.body, a.text);
    if (Number.isFinite(own) && other != null && own !== other) a.delta = `${own > other ? '+' : '-'}${Math.round(Math.abs(own - other) * 10) / 10}`;
  }
  const lost = (hovered.lost ?? []).map(text => ({ text, ...mark(text) }));
  // compare mode: the game marks every changed stat with "(+…)"/"(-…)" and lists what you'd lose
  const comparing = lost.length > 0 || stats.some(a => a.delta);
  const better = comparing ? stats.filter(a => a.delta && !a.delta.startsWith('-')) : [];
  const lower = comparing ? stats.filter(a => a.delta?.startsWith('-')) : [];
  const equal = comparing ? stats.filter(a => !a.delta) : [];
  if (comparing) {
    const group = (list, sign, factor, label) => list.length
      && add(sign * factor * list.reduce((n, a) => n + statWeight(a), 0), `${label}: ${list.map(statName).join(', ')}`);
    group(better, 1, 1, 'beter of nieuw');
    group(lower, -1, 0.5, 'lager'); // a smaller roll of a stat you keep
    group(lost, -1, 1, 'kwijt');
  } else {
    // no compare tooltip: fall back on build fit and own value comparison against the remembered item
    const e = equipped ? compare(equipped, phase) : null;
    if (h && e) {
      add(Math.sign(h.score - e.score) * 1.5, `build ${h.score}% (nu ${e.score}%)`);
      let up = 0, down = 0;
      for (const a of h.affixes.filter(a => a.ok && !a.tempered)) {
        if (!e.affixes.find(b => b.text === a.text)?.ok) continue;
        const hv = affixValue(hovered.body, a.text), ev = affixValue(equipped.body, a.text);
        if (hv == null || ev == null || hv === ev) continue;
        hv > ev ? up++ : down++;
      }
      add(Math.sign(up - down) * 0.5, `${up} hogere / ${down} lagere waarden`);
    }
  }
  if (equipped && hovered.power && equipped.power) {
    const d = hovered.power - equipped.power;
    if (Math.abs(d) >= 25) add(Math.sign(d) * 0.5, `${d > 0 ? '+' : ''}${d} item power`);
  }
  const groups = comparing ? { better, lower, equal, lost } : { stats };
  if (!pos.length && !neg.length) return { kind: equipped || h ? 'equal' : 'unknown', pos, neg, ...groups };
  const kind = !neg.length ? 'upgrade' : !pos.length ? 'downgrade' : total > 0.5 ? 'upgrade' : total < -0.5 ? 'downgrade' : 'sidegrade';
  return { kind, pos, neg, total: Math.round(total * 100) / 100, ...groups };
}
