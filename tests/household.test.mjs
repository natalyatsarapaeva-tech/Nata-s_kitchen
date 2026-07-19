import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_HOUSEHOLD_ID, canEditRecipeAs, makeJoinCode, normalizeJoinCode,
  makeHouseholdId, overlayStates,
} from '../js/household-core.js';

test('canEditRecipeAs: автор правит своё, легаси — только легаси-семья', () => {
  // легаси-рецепты (до auth) — свои для семьи 'default'
  assert.equal(canEditRecipeAs({}, 'uid1', LEGACY_HOUSEHOLD_ID), true);
  assert.equal(canEditRecipeAs({ createdBy: 'default' }, 'uid1', LEGACY_HOUSEHOLD_ID), true);
  assert.equal(canEditRecipeAs({ createdBy: 'default' }, 'uid1', 'sestra-x1'), false);
  // авторские — только автор, независимо от семьи
  assert.equal(canEditRecipeAs({ createdBy: 'uid1' }, 'uid1', 'sestra-x1'), true);
  assert.equal(canEditRecipeAs({ createdBy: 'uid1' }, 'uid2', 'sestra-x1'), false);
  assert.equal(canEditRecipeAs({ createdBy: 'uid1' }, null, 'default'), false);
});

test('makeJoinCode: 6 символов без похожих, детерминизм по rand', () => {
  const code = makeJoinCode(() => 0);
  assert.equal(code.length, 6);
  assert.equal(code, 'AAAAAA');
  const real = makeJoinCode();
  assert.match(real, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.doesNotMatch(real, /[ILO01]/, 'без визуально похожих символов');
});

test('normalizeJoinCode: регистр, пробелы, мусор', () => {
  assert.equal(normalizeJoinCode(' k7m 3nd '), 'K7M3ND');
  assert.equal(normalizeJoinCode('k7-m3-nd'), 'K7M3ND');
  assert.equal(normalizeJoinCode(''), '');
});

test('makeHouseholdId: слаг имени + случайный хвост', () => {
  const id = makeHouseholdId('Мама и папа', () => 0.5);
  assert.match(id, /^мама-и-папа-[a-z0-9]+$/);
  assert.match(makeHouseholdId(''), /^семья-/);
  assert.notEqual(makeHouseholdId('Дом'), makeHouseholdId('Дом'), 'хвост случайный');
});

test('overlayStates: легаси-история достаётся только легаси-семье', () => {
  const recipes = [
    { id: 'a', timesCooked: 5, lastCookedAt: '2026-01-01' },
    { id: 'b' },
  ];
  const states = { b: { timesCooked: 1, lastCookedAt: '2026-07-01' } };
  // легаси-семья: поля на рецепте — валидный fallback
  const legacy = overlayStates(recipes, states, true);
  assert.equal(legacy[0].timesCooked, 5);
  assert.equal(legacy[1].timesCooked, 1);
  // новая семья: чужая история не видна, своя из recipeState — видна
  const fresh = overlayStates(recipes, states, false);
  assert.equal(fresh[0].timesCooked, undefined);
  assert.equal(fresh[0].lastCookedAt, undefined);
  assert.equal(fresh[1].timesCooked, 1);
});
