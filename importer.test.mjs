import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, buildFromProfile, resolveProfileId, cellCode, dropSources, socketsOf } from './importer.mjs';

test('unique drop sources come from the boss loot pool', () => {
  assert.deepEqual(dropSources({ families: ['GrigoireUniques'] }), ['Grigoire, the Galvanic Saint']);
  assert.match(dropSources({ magicType: 4 })[0], /^Mythic/);
  assert.match(dropSources({ magicType: 2 })[0], /geen vaste boss/);
});

test('paragon cell codes', () => {
  assert.equal(cellCode(null), '.');
  assert.equal(cellCode('Generic_Gate', 0), 'g');
  assert.equal(cellCode('Generic_Socket', 0), 's');
  assert.equal(cellCode('Generic_Normal_Str', 0), 'n');
  assert.equal(cellCode('Generic_Magic_Dex', 2), 'm');
  assert.equal(cellCode('Barbarian_Rare_005', 3), 'r');
  assert.equal(cellCode('Barbarian_Legendary_001', 4), 'l');
});

test('skills and paragon are imported per phase, using the class tree', () => {
  const min = {
    affixes: {}, attributes: {}, items: {},
    classes: { 2: { name: 'Barbarian' }, 0: { name: 'Sorcerer' } },
    skills: { Barb_WW: { id: 1, mods: [{ id: 77 }] } },
    // node 5 exists in both trees; the Barbarian one must win
    skillTrees: { Sorcerer: { nodes: [{ id: 5, rewardId: 'Sorc_X' }] }, Barbarian: { nodes: [{ id: 5, rewardId: 'Unlock_WW', requiredLevel: 2 }, { id: 6, rewardId: 'Mod_WW' }] } },
    skillTreeRewards: { Unlock_WW: { type: 0, power: 'Barb_WW', ranks: 15 }, Mod_WW: { type: 1, power: 'Barb_WW', ranks: 3, mod: 77 }, Sorc_X: { type: 0, power: 'Nope', ranks: 1 } },
    paragonBoards: { Board_A: { width: 3, nodes: [null, 'Generic_Gate', null, 'Generic_Normal_Str', 'Barb_Legendary_1', 'Generic_Socket', null, null, null] } },
    paragonNodes: { Generic_Gate: { rarity: 0 }, Generic_Normal_Str: { rarity: 0 }, Barb_Legendary_1: { rarity: 4 }, Generic_Socket: { rarity: 0 } },
  };
  const en = {
    affixes: {}, attributeDescriptions: {}, items: {}, uiStrings: {}, mercenaries: {},
    classes: { 2: { nameMale: 'Barbarian' } },
    skills: { Barb_WW: { name: 'Whirlwind', mods: [{ name: 'Tornado' }] } },
    paragonBoards: { Board_A: { name: 'Start' } }, paragonNodes: { Barb_Legendary_1: { name: 'Hemorrhage' }, Generic_Socket: { name: 'Glyph Socket' } },
    paragonGlyphs: { G1: { name: 'Marshal' } },
  };
  const data = { items: {}, profiles: [{
    name: 'Endgame', class: 2, items: {}, skillBar: ['Barb_WW'],
    skillTree: { steps: [{ name: 'All', data: { 5: 15, 6: 1, 7: 0 } }] },
    paragon: { steps: [{ name: 'Final', data: [{ id: 'Board_A', rotation: 1, glyph: 'G1', glyphLevel: 21, nodes: { 4: 1, 3: 1 } }] }] },
  }] };
  const [ph] = buildFromProfile({ id: 'x', name: 'T', data: JSON.stringify(data) }, min, en).phases;
  assert.equal(ph.class, 'Barbarian');
  assert.deepEqual(ph.skills.bar, ['Whirlwind']);
  assert.deepEqual(ph.skills.steps[0].nodes.map(n => `${n.kind}:${n.name}:${n.rank}`), ['skill:Whirlwind:15', 'upgrade:Whirlwind: Tornado:1']);
  const [b] = ph.paragon.steps[0].boards;
  assert.equal(b.name, 'Start');
  assert.equal(b.cells, '.g.nls...');
  assert.deepEqual(b.selected, [3, 4]);
  assert.deepEqual(b.glyph, { name: 'Marshal', level: 21 });
  assert.equal(b.rotation, 1);
  assert.equal(b.labels[4], 'Hemorrhage');
});

test('render fills values, percentages and params', () => {
  assert.equal(render('+[{value}||] Maximum Life', [1500]), '+1500 Maximum Life');
  assert.equal(render('x[{value2}*100|%|] {value1} Damage Multiplier', [0.16], 'Physical'), 'x16% Physical Damage Multiplier');
  assert.equal(render('damage is increased by {c_random}[Affix_Value_1|%x|]{/c}.', [140]), 'damage is increased by 140%.');
  assert.equal(render('Rank {if:ADVANCED_TOOLTIP}[{value}|1|]{else}[{value}|1|]{/if} {u}Berserking{/u}', [26]), 'Rank 26 Berserking');
  // an {if} without {else} must not swallow text up to a later {else}
  assert.equal(render('{if:A}x{/if}When enraged granting {if:B}y{else}[{value}|%|]{/if} damage', [65]), 'xWhen enraged granting 65% damage');
});

test('resolveProfileId accepts planner links and bare ids', async () => {
  assert.equal(await resolveProfileId('https://maxroll.gg/d4/planner/qeyb7t0x#1'), 'qeyb7t0x');
  assert.equal(await resolveProfileId('qeyb7t0x'), 'qeyb7t0x');
});

test('resolveProfileId finds the planner in old and new guide pages, not in related guides', async () => {
  const page = html => async () => html;
  const guide = 'https://maxroll.gg/d4/build-guides/x-guide';
  assert.equal(await resolveProfileId(guide, page('<div data-d4-profile="qeyb7t0x"></div>')), 'qeyb7t0x');
  // new layout (Oct 2026): related guides' embed_id comes first in the page data
  assert.equal(await resolveProfileId(guide, page('"skills":{"embed_id":"other123"},"gutenbergBlock":[{"attributes":{"link":"https://maxroll.gg/d4/planner/mmfzmj0i#4"},"blockName":"maxroll/planner-page","plannerProfile":{"id":"mmfzmj0i","name":"Dance"}}]')), 'mmfzmj0i');
  await assert.rejects(resolveProfileId(guide, page('<p>no planner</p>')), /Geen build-planner/);
});

test('buildFromProfile maps slots, duplicate rings and affix text', () => {
  const min = {
    affixes: { Str: { id: 1, attributes: [{ id: 4 }] }, Asp: { id: 2 } },
    attributes: { 4: { name: 'Strength' } },
    skills: {},
    items: { Ring_A: { type: 'Ring' }, Helm_Unique_X: { type: 'Helm' } },
  };
  const en = {
    affixes: { Asp: { desc: 'deal [Affix_Value_1|%|] more' } },
    attributeDescriptions: { Strength: '[{value}|~|] Strength' },
    items: { Helm_Unique_X: { name: 'Big Hat' } },
    skills: {},
    uiStrings: {},
  };
  const data = {
    items: {
      1: { id: 'Ring_A', explicits: [{ nid: 1, values: [30] }], aspects: [{ nid: 2, values: [20] }] },
      2: { id: 'Helm_Unique_X', explicits: [{ nid: 99, values: [1] }] },
    },
    profiles: [{ name: 'Starter', items: { 4: 2, 11: 1, 12: 1 } }],
  };
  const b = buildFromProfile({ id: 'abc', name: 'Test', data: JSON.stringify(data) }, min, en);
  const s = b.phases[0].slots;
  assert.deepEqual(Object.keys(s), ['Helm', 'Ring', 'Ring 2']);
  assert.equal(s.Helm.unique, true);
  assert.equal(s.Helm.name, 'Big Hat');
  assert.equal(s.Helm.affixes[0].text, 'unknown affix 99');
  assert.equal(s.Ring.affixes[0].text, '30 Strength');
  assert.equal(s['Ring 2'].aspects[0].text, 'deal 20% more');
});

test('sockets: gem effect per slot kind, runeword pair, duplicates counted', () => {
  const min = { items: {
    Gem_Skull_04: { type: 'Gem', socketedEffects: [{ type: 0, attributes: [{ value: 0.18 }] }, { type: 1, attributes: [{ value: 0.08 }] }, { type: 2, attributes: [{ value: 450 }] }] },
    Rune_Condition_X: { type: 'ConditionRune', rune: {} },
    Rune_Effect_Y: { type: 'EffectRune', rune: {} },
  } };
  const en = { items: {
    Gem_Skull_04: { name: 'Skull', socketedEffects: [{ label: 'x[{value}*100|%|] Physical Damage Multiplier' }, { label: '+[{value}*100|1%|] Healing Received' }, { label: '+[{value}||] Physical Resistance' }] },
    Rune_Condition_X: { name: 'Igni', rune: { desc: '{c_RuneCondition}Stores Offering every {c_number}0.3{/c} |4second:seconds;.{/c}' } },
    Rune_Effect_Y: { name: 'Sol', rune: { desc: 'Gain {c_number}15%{/c} Damage Reduction for {c_number}{s1}{/c} seconds.' } },
  } };
  assert.deepEqual(socketsOf(min, en, ['Gem_Skull_04', 'Gem_Skull_04'], 'Mace2H').map(s => [s.count, s.name, s.effect]), [[2, 'Skull', 'x18% Physical Damage Multiplier']]);
  assert.equal(socketsOf(min, en, ['Gem_Skull_04'], 'Helm')[0].effect, '+8% Healing Received');
  assert.equal(socketsOf(min, en, ['Gem_Skull_04'], 'Ring 2')[0].effect, '+450 Physical Resistance');
  assert.deepEqual(socketsOf(min, en, ['Rune_Condition_X', 'Rune_Effect_Y'], 'ChestArmor').map(s => [s.kind, s.effect]),
    [['condition', 'Stores Offering every 0.3 seconds.'], ['effect', 'Gain 15% Damage Reduction for # seconds.']]);
});
