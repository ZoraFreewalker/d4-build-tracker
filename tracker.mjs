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
    if (equippedDps > 0) out.damage = Math.round((diff / equippedDps) * 1000) / 10;
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
      if ((nameLines[0]?.y ?? head.y) - l.y > head.h * 2.6) break;
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
    return {
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
    const affixes = [...s.affixes, ...s.tempered.map(a => ({ ...a, tempered: true }))]
      .map(a => ({ text: a.text, tempered: !!a.tempered, ok: hasText(tooltip.body, a.text) }));
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

// Is the hovered item an upgrade over the equipped one? Combines the game's own damage/toughness delta
// (strongest signal), build fit, higher values on the build affixes and item power. Returns kind + reasons.
export function verdict(hovered, equipped, phase) {
  const pos = [], neg = [];
  let total = 0;
  const add = (weight, diff, text) => {
    if (!diff) return;
    total += Math.sign(diff) * weight;
    (diff > 0 ? pos : neg).push(text);
  };
  const pct = v => `${v > 0 ? '+' : ''}${Math.round(v * 10) / 10}%`;
  const { damage, toughness } = hovered.deltas ?? {};
  if (damage !== undefined) add(2, damage, `${pct(damage)} damage`);
  if (toughness !== undefined) add(1, toughness, `${pct(toughness)} toughness`);

  const h = compare(hovered, phase);
  const e = equipped ? compare(equipped, phase) : null;
  if (h && e) {
    add(1.5, h.score - e.score, `build ${h.score}% (nu ${e.score}%)`);
    let better = 0, worse = 0;
    for (const a of h.affixes.filter(a => a.ok && !a.tempered)) {
      if (!e.affixes.find(b => b.text === a.text)?.ok) continue;
      const hv = affixValue(hovered.body, a.text), ev = affixValue(equipped.body, a.text);
      if (hv == null || ev == null || hv === ev) continue;
      hv > ev ? better++ : worse++;
    }
    add(0.5, better - worse, `${better} hogere / ${worse} lagere waarden`);
  }
  if (equipped && hovered.power && equipped.power) {
    const d = hovered.power - equipped.power;
    if (Math.abs(d) >= 25) add(0.5, d, `${d > 0 ? '+' : ''}${d} item power`);
  }
  if (!pos.length && !neg.length) return { kind: equipped || h ? 'equal' : 'unknown', pos, neg };
  const kind = !neg.length ? 'upgrade' : !pos.length ? 'downgrade' : total > 0.5 ? 'upgrade' : total < -0.5 ? 'downgrade' : 'sidegrade';
  return { kind, pos, neg };
}
