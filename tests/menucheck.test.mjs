import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MENU_CHECK_PROMPT, describeWeekForCheck,
  buildMenuCheckUserMsg, parseMenuCheckResult,
} from '../js/menucheck.js';

const RECIPES = {
  'c-ki': { id: 'c-ki', title: 'Курица + Киноа', combo: { protein: 'Курица', side: 'Киноа' },
    tags: ['regular'], ingredients: [{ n: 'Курица', a: '300 г' }] },
  'f-ka': { id: 'f-ka', title: 'Рыба + Картошка', combo: { protein: 'Белая рыба', side: 'Картошка' },
    tags: ['regular'], ingredients: [{ n: 'Треска', a: '300 г' }] },
  'soup': { id: 'soup', title: 'Борщ', tags: ['soup'], ingredients: [{ n: 'Говядина', a: '300 г' }] },
};

const SLOTS = {
  mon_dinner: { recipeId: 'c-ki', locked: false },
  tue_lunch: { recipeId: 'f-ka', kind: 'reheat', linkedTo: 'mon_dinner' },
  tue_dinner: { recipeId: 'soup', locked: true },
};

test('describeWeekForCheck: строки по слотам с деталями', () => {
  const text = describeWeekForCheck(SLOTS, RECIPES);
  assert.match(text, /mon_dinner — Пн .*Курица \+ Киноа/);
  assert.match(text, /белок: курица/);
  assert.match(text, /гарнир: киноа/);
  // разогрев и закреплённое помечаются
  assert.match(text, /tue_lunch.*разогрев вчерашнего/);
  assert.match(text, /tue_dinner.*🔒 закреплено/);
  // борщ без combo → класс белка (мясо) как fallback
  assert.match(text, /белок: мясо/);
});

test('describeWeekForCheck: пустые слоты пропускаются', () => {
  const text = describeWeekForCheck({ mon_dinner: { recipeId: null }, wed_lunch: {} }, RECIPES);
  assert.equal(text, '');
});

test('parseMenuCheckResult: только валидные id слотов, дубли убираются', () => {
  const out = parseMenuCheckResult({
    reroll: ['mon_dinner', 'mon_dinner', 'sat_breakfast', 'мусор', 'xxx_lunch', 42, null],
    notes: '  слишком много киноа  ',
  });
  assert.deepEqual(out.reroll, ['mon_dinner', 'sat_breakfast']);
  assert.equal(out.notes, 'слишком много киноа');
});

test('parseMenuCheckResult: мусор — пустой безопасный результат', () => {
  assert.deepEqual(parseMenuCheckResult(null), { reroll: [], notes: '' });
  assert.deepEqual(parseMenuCheckResult({ reroll: 'нет' }), { reroll: [], notes: '' });
});

test('buildMenuCheckUserMsg и дефолтный промпт', () => {
  assert.match(buildMenuCheckUserMsg('mon_dinner — ...'), /mon_dinner/);
  assert.match(DEFAULT_MENU_CHECK_PROMPT, /киноа/);
  assert.match(DEFAULT_MENU_CHECK_PROMPT, /разогрев/i);
  assert.match(DEFAULT_MENU_CHECK_PROMPT, /"reroll"/);
});
