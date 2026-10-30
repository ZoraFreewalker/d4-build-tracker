import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTooltips, compare, hasText, slotType, progress, outside, screenContext, itemPower, gameDeltas, affixValue, verdict } from './tracker.mjs';


test('weapon tooltips: "(Bludgeoning)" type, DPS delta, lost properties (real OCR)', () => {
  const lines = [
    { text: 'EQUIPPED', x: 1897, y: 578, w: 150, h: 24 },
    { text: 'CLUB', x: 1749, y: 652, w: 90, h: 24 },
    { text: 'Mace (Bludgeoning)', x: 1749, y: 698, w: 250, h: 19 },
    { text: '19 Item Power', x: 1751, y: 736, w: 180, h: 19 },
    { text: '23 Damage Per Second', x: 1748, y: 802, w: 280, h: 23 },
    { text: 'Sell Value: 7.', x: 2044, y: 957, w: 160, h: 21 },
    { text: 'POWERFUL', x: 2143, y: 527, w: 140, h: 25 },
    { text: 'SHORTSWORD', x: 2143, y: 565, w: 190, h: 24 },
    { text: 'Magic Sword (Slashing)', x: 2143, y: 609, w: 280, h: 25 },
    { text: '82 Item Power', x: 2143, y: 648, w: 180, h: 19 },
    { text: '27 Damage Per Second (+1)', x: 2142, y: 715, w: 330, h: 22 },
    { text: 'o +1 Strength - 101 (+1)', x: 2149, y: 838, w: 260, h: 13 },
    { text: 'Properties lost when equipped:', x: 2141, y: 892, w: 360, h: 24 },
    { text: '+1 Weapon Damage', x: 2175, y: 928, w: 220, h: 18 },
  ];
  const tips = parseTooltips(lines);
  const club = tips.find(t => t.name === 'CLUB'), sword = tips.find(t => t.name === 'POWERFUL SHORTSWORD');
  assert.equal(club.slotType, 'Mace');
  assert.equal(club.rarity, 'common');
  assert.equal(club.equipped, true);
  assert.equal(sword.slotType, 'Sword');
  assert.equal(sword.power, 82);
  assert.deepEqual(sword.deltas, { damage: 3.8 });
  assert.ok(!/Weapon Damage/.test(sword.body), 'lost properties are not part of the item');
});

test('item power, game deltas and affix values are read from tooltip text', () => {
  assert.equal(itemPower('760+25 Item Power'), 785);
  assert.equal(itemPower('500 Item Power'), 500);
  assert.deepEqual(gameDeltas('10 Item Power 19 Armor (-21.5% Toughness)'), { toughness: -21.5 });
  assert.deepEqual(gameDeltas('298 Damage Per Second (+12.3% Damage)'), { damage: 12.3 });
  assert.deepEqual(gameDeltas('19 Armor (21.5% Toughness)'), {}); // sign lost by OCR: unknown
  const body = '+30 Strength [20 - 30] +115 Maximum Life [71 - 115] +228 Resistance to All Elements [203 - 228] +1,101 Armor';
  assert.equal(affixValue(body, '30 Strength'), 30);
  assert.equal(affixValue(body, '+115 Maximum Life'), 115);
  assert.equal(affixValue(body, '+228 Resistance to All Elements'), 228);
  assert.equal(affixValue(body, '+1101 Armor'), 1101);
  assert.equal(affixValue(body, '+5% Attack Speed'), null);
});

test('one tooltip line counts for one build affix (screenshot: Death Garb vs Vigorous Leather Doublet)', () => {
  const phase = { slots: { ChestArmor: { unique: false, aspects: [], name: 'Runic Mail',
    affixes: [{ text: '30 Strength' }, { text: '+115 Maximum Life' }, { text: '3 Fury Regeneration' }, { text: '+1101 Armor' }, { text: '+228 Resistance to All Elements' }],
    tempered: [{ text: '+1500 Maximum Life' }] } } };
  const doublet = { slotType: 'ChestArmor', name: 'VIGOROUS LEATHER DOUBLET OF REGENERATION', power: 102, deltas: {},
    body: '102 Item Power +1 Maximum Life [1 - 4] +1 Life Regeneration [1]' };
  const garb = { slotType: 'ChestArmor', name: 'DEATH GARB', power: 140, deltas: { toughness: 3.2 },
    body: '140 Item Power +2 Strength +[1 - 7] (+2) +2 Maximum Resource [1 - 5] (+2) 1.3% Resource Cost Reduction [1.0 - 2.0]% (+1.3%)' };
  const d = compare(doublet, phase);
  assert.deepEqual(d.affixes.filter(a => a.ok).map(a => a.text), ['+115 Maximum Life']); // not also the temper
  assert.equal(d.score, 20);
  assert.equal(compare(garb, phase).score, 20);
  assert.equal(verdict(garb, doublet, phase).kind, 'upgrade');
  // two real "Maximum Life" lines do satisfy affix and temper
  assert.equal(compare({ ...doublet, body: '+115 Maximum Life +1500 Maximum Life' }, phase).score, 40);
});

test('upgrade verdict combines game deltas, build fit, values and item power', () => {
  const phase = { slots: { Legs: { unique: false, aspects: [], tempered: [], affixes: [{ text: '30 Strength' }, { text: '+115 Maximum Life' }] } } };
  const item = (body, extra = {}) => ({ slotType: 'Legs', name: 'x', body, power: 500, deltas: {}, ...extra });
  const hide = item('', { power: 10 });
  const rare = item('+30 Strength +115 Maximum Life', { power: 500, deltas: { toughness: 35 } });
  assert.equal(verdict(rare, hide, phase).kind, 'upgrade');
  assert.equal(verdict({ ...hide, deltas: { toughness: -21.5 } }, rare, phase).kind, 'downgrade');
  // more toughness but loses a build affix and has lower values: mixed
  const worse = item('+20 Strength', { deltas: { toughness: 5 } });
  const better = item('+30 Strength +115 Maximum Life');
  assert.equal(verdict(worse, better, phase).kind, 'downgrade');
  assert.equal(verdict(item('+20 Strength +115 Maximum Life', { deltas: { damage: 3 } }), better, phase).kind, 'upgrade'); // the game's damage figure already includes the lower Strength
  assert.equal(verdict(item('+20 Strength +115 Maximum Life', { deltas: { damage: 3, toughness: -6 } }), better, phase).kind, 'sidegrade');
  // no equipped data and no game delta: only the fit is known
  assert.equal(verdict(better, null, phase).kind, 'equal');
});

test('skill tree / paragon screen detection (OCR of the ABILITIES panel)', () => {
  const l = (...texts) => texts.map(text => ({ text, x: 0, y: 0, w: 1, h: 1 }));
  assert.equal(screenContext(l('ABILITIES O', 'Skill Tree', 'Available Points', 'Paragon (Lv. 70)', 'Keyword Search')), 'skills');
  assert.equal(screenContext(l('ABILITIES', 'Skill Tree', 'Paragon (Lv. 70)', 'Keyword Search')), 'paragon');
  assert.equal(screenContext(l('Strength 12', 'Weapon Damage')), null);
});

test('tooltip stops at its footer, ignores UI to the right and the base armor line', () => {
  const lines = [
    { text: 'HIDE PANTS', x: 2610, y: 790, w: 230, h: 30 },
    { text: 'Pants', x: 2610, y: 845, w: 80, h: 24 },
    { text: '10 Item Power', x: 2610, y: 885, w: 200, h: 24 },
    { text: '19 Armor (-21.5% Toughness)', x: 2610, y: 960, w: 430, h: 26 },
    { text: 'Fury Regeneration 3', x: 2930, y: 980, w: 250, h: 22 }, // character panel next to the tooltip
    { text: 'Sell Value: 2', x: 2950, y: 1055, w: 160, h: 22 },
    { text: '+1,101 Armor', x: 2610, y: 1100, w: 160, h: 22 }, // below the footer: another UI element
  ];
  const [t] = parseTooltips(lines);
  assert.equal(t.slotType, 'Legs');
  assert.ok(!hasText(t.body, '3 Fury Regeneration'));
  assert.ok(!hasText(t.body, '+1101 Armor'));
});

test('weapons match slots of the same arsenal role', () => {
  const phase = { slots: {
    Mace2H: { unique: false, aspects: [], tempered: [], affixes: [] },
    Polearm: { unique: false, aspects: [], tempered: [], affixes: [] },
    Sword: { unique: false, aspects: [], tempered: [], affixes: [] },
    'Sword 2': { unique: false, aspects: [], tempered: [], affixes: [] },
  } };
  const slotOf = slotType => compare({ slotType, body: '', name: 'x' }, phase)?.slot;
  assert.equal(slotOf('Axe'), 'Sword');
  assert.equal(slotOf('Axe2H'), 'Polearm');
  assert.equal(slotOf('Mace2H'), 'Mace2H');
  assert.equal(slotOf('Bow'), undefined);
});

test('OCR lines on the overlay itself are dropped', () => {
  const overlayRect = { x: 0, y: 0, width: 400, height: 600 };
  const lines = [
    { text: 'legendary Horadric Seal', x: 20, y: 300, w: 200, h: 20 }, // overlay text
    { text: 'Rare Helm', x: 900, y: 300, w: 120, h: 20 }, // game tooltip
  ];
  assert.deepEqual(outside(lines, [overlayRect]).map(l => l.text), ['Rare Helm']);
});

test('progress fills duplicate slots with the best equipped items', () => {
  const phase = { slots: { Helm: {}, Ring: {}, 'Ring 2': {}, Boots: {} } };
  const p = progress(phase, { Ring: { A: 50, B: 100 }, Helm: { H: 100 } });
  assert.deepEqual(p.slots.map(s => s.score), [100, 100, 50, 0]);
  assert.equal(p.percent, 63);
  assert.equal(p.next.slot, 'Boots');
});

// OCR output of samples/6.webp (trimmed), as produced by ocr.ps1
const axeLines = [
  { text: 'EQUIPPED', x: 965, y: 61, w: 150, h: 20 },
  { text: 'THOUSAND-EYE', x: 818, y: 133, w: 250, h: 25 },
  { text: 'REAVER *', x: 820, y: 170, w: 150, h: 25 },
  { text: 'Ancestral Unique Axe', x: 819, y: 216, w: 230, h: 20 },
  { text: '800 Item Power', x: 819, y: 254, w: 170, h: 20 },
  { text: 'o +175.0% Damage to Injured', x: 824, y: 442, w: 300, h: 20 },
  { text: 'Enemies [175.01%', x: 851, y: 470, w: 170, h: 20 },
  { text: '+457 Maximum Life [424-457]', x: 851, y: 528, w: 300, h: 20 },
  { text: 'o +8.0% Critical Strike Chance [7.0 -', x: 824, y: 572, w: 380, h: 20 },
  { text: '8.01%', x: 851, y: 600, w: 60, h: 20 },
];

test('parses an equipped unique tooltip', () => {
  const [t] = parseTooltips(axeLines);
  assert.equal(t.name, 'THOUSAND-EYE REAVER');
  assert.equal(t.rarity, 'unique');
  assert.equal(t.slotType, 'Axe');
  assert.equal(t.equipped, true);
});

test('a wrapped "Ancestral Mythic Unique" type line takes the slot from the next line', () => {
  const [t] = parseTooltips([
    { text: "GOHR'S DEVASTATING", x: 72, y: 58, w: 300, h: 30 },
    { text: 'GRIPS', x: 72, y: 99, w: 100, h: 30 },
    { text: 'Ancestral Mythic Unique', x: 68, y: 140, w: 300, h: 25 },
    { text: 'Gloves', x: 70, y: 181, w: 90, h: 25 },
    { text: '+4 to Whirlwind', x: 110, y: 600, w: 200, h: 25 },
  ]);
  assert.equal(t.slotType, 'Gloves');
  assert.equal(t.rarity, 'mythic');
  assert.ok(!t.body.includes('Gloves'));
});

test('a centered Legendary Aspect tooltip maps to the slots that use it', () => {
  const [t] = parseTooltips([
    { text: 'Aspect of Anger Management', x: 65, y: 85, w: 485, h: 30 },
    { text: 'Legendary Aspect', x: 192, y: 125, w: 230, h: 25 },
    { text: 'While above 50 Primary Resource,', x: 88, y: 195, w: 410, h: 25 },
    { text: 'deal [15.0 - 20.0]%[x] increased', x: 88, y: 233, w: 400, h: 25 },
    { text: 'damage and gain Berserking, but', x: 88, y: 271, w: 420, h: 25 },
    { text: 'lose 3 Primary Resource Regeneration.', x: 88, y: 309, w: 420, h: 25 },
  ]);
  assert.equal(t.name, 'Aspect of Anger Management');
  const phase = { slots: {
    Helm: { aspects: [{ text: 'While above 50 Primary Resource, deal 20% increased damage and gain Berserking, but lose 3 Primary Resource Regeneration.' }] },
    Boots: { aspects: [{ text: 'After swapping weapons 5 times gain Berserking for 4 seconds.' }] },
  } };
  assert.equal(compare(t, phase).slot, 'Helm');
});

test('a common item without rarity word is recognized (real OCR from the game)', () => {
  const lines = [
    { text: 'EQUIPPED', x: 2477, y: 620, w: 150, h: 24 },
    { text: 'HIDE BOOTS', x: 2328, y: 694, w: 200, h: 25 },
    { text: 'Boots', x: 2328, y: 742, w: 90, h: 20 },
    { text: '10 Item Power', x: 2330, y: 778, w: 200, h: 20 },
    { text: '8 Armor', x: 2328, y: 846, w: 100, h: 23 },
  ];
  const tips = parseTooltips(lines);
  assert.equal(tips.length, 1);
  assert.equal(tips[0].name, 'HIDE BOOTS');
  assert.equal(tips[0].rarity, 'common');
  assert.equal(tips[0].slotType, 'Boots');
  assert.equal(tips[0].equipped, true);
  assert.ok(!hasText(tips[0].body, '+550 Armor'), 'base armor is not an affix');
  // a normal tooltip must not also produce a common duplicate
  assert.equal(parseTooltips(axeLines.concat({ text: '800 Item Power', x: 819, y: 254, w: 170, h: 20 })).length, 1);
});

test('slot types follow Maxroll naming', () => {
  assert.equal(slotType('Two-Handed Mace'), 'Mace2H');
  assert.equal(slotType('Chest Armor'), 'ChestArmor');
  assert.equal(slotType('Pants'), 'Legs');
});

test('affix text matches across line wraps and ignores values', () => {
  const body = parseTooltips(axeLines)[0].body;
  assert.ok(hasText(body, '+25% Damage to Injured Enemies'));
  assert.ok(hasText(body, '+10.6% Critical Strike Chance'));
  assert.ok(!hasText(body, '+20% Critical Strike Damage'));
});

test('a rare with 4 of 6 listed affixes scores 100% (items hold max 4)', () => {
  const lines = [
    { text: 'ORDER AGENT', x: 40, y: 60, w: 200, h: 25 },
    { text: 'Rare Chest Armor', x: 40, y: 100, w: 200, h: 20 },
    { text: '+30 Strength [20 - 30]', x: 80, y: 280, w: 200, h: 20 },
    { text: '+115 Maximum Life [71 - 115]', x: 80, y: 320, w: 200, h: 20 },
    { text: '+3 Fury Regeneration [2 - 3]', x: 80, y: 360, w: 200, h: 20 },
    { text: '+1,101 Armor [918 - 1,101]', x: 80, y: 400, w: 200, h: 20 },
  ];
  const phase = { slots: { ChestArmor: { unique: false, name: 'Runic Mail', aspects: [], tempered: [], affixes: [
    { text: '30 Strength' }, { text: '+115 Maximum Life' }, { text: '3 Fury Regeneration' },
    { text: '+1101 Armor' }, { text: '+228 Resistance to All Elements' }, { text: '+5% Attack Speed' },
  ] } } };
  assert.equal(compare(parseTooltips(lines)[0], phase).score, 100);
});

test('compare scores against the matching build slot', () => {
  const phase = { slots: {
    Axe: { unique: true, name: 'Thousand-Eye Reaver', aspects: [], tempered: [],
      affixes: [{ text: '+500 Maximum Life' }, { text: '+5% Attack Speed' }] },
  } };
  const r = compare(parseTooltips(axeLines)[0], phase);
  assert.equal(r.item, true);
  assert.deepEqual(r.affixes.map(a => a.ok), [true, false]);
  assert.equal(r.score, 100); // uniques score on name; affix list stays informational
  phase.slots.Axe.name = 'Other Axe';
  assert.equal(compare(parseTooltips(axeLines)[0], phase).score, 0);
});
