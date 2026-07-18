import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  weekStartISO, buildSlots, generateWeek, rerollSlot,
  aggregateShopping, shoppingAmountLabel, weekTotals, DAYS
} from '../js/planner.js';
import { filterCandidates } from '../js/suggest.js';
import { buildDict } from '../js/nutrition-core.js';

const NOW = Date.parse('2026-07-18T18:00:00Z');

test('weekStartISO: понедельник недели', () => {
  assert.equal(weekStartISO(new Date('2026-07-18T12:00:00')), '2026-07-13'); // суббота → пн 13-е
  assert.equal(weekStartISO(new Date('2026-07-13T00:30:00')), '2026-07-13'); // сам понедельник
  assert.equal(weekStartISO(new Date('2026-07-19T23:00:00')), '2026-07-13'); // воскресенье → тот же пн
});

test('buildSlots: из настроек семьи', () => {
  assert.equal(buildSlots({ planMeals: ['dinner'] }).length, 7);
  const both = buildSlots({ planMeals: ['lunch', 'dinner'] });
  assert.equal(both.length, 14);
  assert.deepEqual(both.slice(0, 2).map(s => s.id), ['mon_lunch', 'mon_dinner']);
  // дефолт — ужины
  assert.equal(buildSlots({}).length, 7);
});

const CATALOG = Array.from({ length: 10 }, (_, i) => ({
  id: `r${i}`, title: `Блюдо ${i}`, tags: ['veggie'], meta: '~30 мин',
  ingredients: [{ n: `Овощ${i}`, a: '100 г' }],
}));

test('generateWeek: заполняет все слоты без повторов', () => {
  const profile = { planMeals: ['dinner'], rhythm: {} };
  const slots = generateWeek(CATALOG, profile, {}, null, NOW, () => 0);
  const ids = Object.values(slots).map(s => s.recipeId);
  assert.equal(ids.length, 7);
  assert.ok(ids.every(Boolean));
  assert.equal(new Set(ids).size, 7, 'все блюда недели разные');
});

test('generateWeek: залоченные слоты сохраняются и участвуют в анти-повторах', () => {
  const profile = { planMeals: ['dinner'], rhythm: {} };
  const existing = { mon_dinner: { recipeId: 'r5', locked: true } };
  const slots = generateWeek(CATALOG, profile, existing, null, NOW, () => 0);
  assert.equal(slots.mon_dinner.recipeId, 'r5');
  assert.equal(slots.mon_dinner.locked, true);
  const others = Object.entries(slots).filter(([id]) => id !== 'mon_dinner').map(([, s]) => s.recipeId);
  assert.ok(!others.includes('r5'), 'закреплённое не дублируется в другие дни');
});

test('generateWeek: маленький каталог — повторы допустимы, слоты не пустуют', () => {
  const small = CATALOG.slice(0, 3);
  const slots = generateWeek(small, { planMeals: ['dinner'], rhythm: {} }, {}, null, NOW, () => 0);
  assert.ok(Object.values(slots).every(s => s.recipeId), 'все слоты заполнены за счёт второго круга');
});

test('generateWeek: бюджет времени дня и исключения семьи соблюдаются', () => {
  const catalog = [
    { id: 'slow', title: 'Долгое', tags: ['veggie'], meta: '~90 мин', ingredients: [{ n: 'Капуста', a: '1 шт' }] },
    { id: 'fast', title: 'Быстрое', tags: ['veggie'], meta: '~15 мин', ingredients: [{ n: 'Огурец', a: '2 шт' }] },
    { id: 'nuts', title: 'С орехами', tags: ['veggie'], meta: '~15 мин', ingredients: [{ n: 'Грецкие орехи', a: '100 г' }] },
  ];
  const profile = { planMeals: ['dinner'], rhythm: { mon: 20 }, exclude: ['орехи'] };
  const slots = generateWeek(catalog, profile, {}, null, NOW, () => 0);
  assert.equal(slots.mon_dinner.recipeId, 'fast'); // в 20 минут влезает только быстрое без орехов
  const all = Object.values(slots).map(s => s.recipeId);
  assert.ok(!all.includes('nuts'), 'исключённые продукты не попадают ни в один день');
});

test('rerollSlot: не предлагает текущее блюдо и занятые в других слотах', () => {
  const profile = { planMeals: ['dinner'], rhythm: {} };
  const slots = {
    mon_dinner: { recipeId: 'r0', locked: false },
    tue_dinner: { recipeId: 'r1', locked: false },
  };
  const next = rerollSlot(CATALOG.slice(0, 3), profile, slots, 'mon_dinner', null, NOW, () => 0);
  assert.equal(next.recipeId, 'r2'); // r0 текущий, r1 занят вторником
});

const DICT = buildDict({
  'картофель': { kcal: 77, protein: 2, fat: 0.1, carbs: 17, unitG: 150, category: 'vegetable' },
  'мука': { kcal: 340, protein: 10, fat: 1, carbs: 70, category: 'grain', isPantryStaple: true },
  'сливки': { kcal: 300, protein: 2.5, fat: 30, carbs: 3, category: 'dairy' },
});

test('aggregateShopping: суммирование, staples исключаются', () => {
  const recipes = {
    a: { id: 'a', ingredients: [
      { n: 'Картофель', a: '3 шт', qty: 3, unit: 'pcs', ing: 'картофель' },
      { n: 'Мука', a: '200 г', qty: 200, unit: 'g', ing: 'мука' },
      { n: 'Сливки', a: '100 мл', qty: 100, unit: 'ml', ing: 'сливки' },
    ]},
    b: { id: 'b', ingredients: [
      { n: 'Картофель', a: '2 шт', qty: 2, unit: 'pcs', ing: 'картофель' },
      { n: 'Сливки', a: '1/2 стакана' }, // не структурировано — граммы из текста
    ]},
  };
  const slots = { mon_dinner: { recipeId: 'a' }, tue_dinner: { recipeId: 'b' } };
  const items = aggregateShopping(slots, recipes, DICT);
  const potato = items.find(i => i.key === 'картофель');
  assert.equal(potato.pcs, 5); // 3 + 2 штуки
  const cream = items.find(i => i.key === 'сливки');
  assert.equal(Math.round(cream.grams), 200); // 100 мл + полстакана(100г)
  assert.ok(!items.find(i => i.key === 'мука'), 'pantry staple не в списке');
  assert.match(shoppingAmountLabel(potato), /5 шт/);
});

test('weekTotals: ккал на порцию по слотам', () => {
  const recipes = {
    a: { id: 'a', servings: 2, ingredients: [
      { n: 'Картофель', a: '600 г', qty: 600, unit: 'g', ing: 'картофель' }] }, // 462 ккал / 2 = 231
  };
  const t = weekTotals({ mon_dinner: { recipeId: 'a' }, tue_dinner: { recipeId: null } }, recipes, DICT);
  assert.equal(t.covered, 1);
  assert.equal(t.total, 1);
  assert.ok(Math.abs(t.kcal - 231) < 1);
});

test('filterCandidates: exclude — жёсткий фильтр с морфологией', () => {
  const rs = [
    { id: 'a', title: 'С грибами', tags: ['veggie'], ingredients: [{ n: 'Шампиньоны', a: '200 г' }] },
    { id: 'b', title: 'Без грибов', tags: ['veggie'], ingredients: [{ n: 'Кабачок', a: '1 шт' }] },
  ];
  assert.deepEqual(filterCandidates(rs, { exclude: ['шампиньон'] }).map(r => r.id), ['b']);
  assert.deepEqual(filterCandidates(rs, { exclude: [] }).map(r => r.id), ['a', 'b']);
});

// ── Батч-кукинг ──
test('isBatchDish: список форматов пользователя', async () => {
  const { isBatchDish } = await import('../js/suggest.js');
  // безусловные: завтраки впрок, запеканки, закуски, рассольник
  for (const title of ['Оладьи кефирные', 'Вафли бельгийские', 'Маффины с черникой',
    'Творожная запеканка', 'Овощная запеканка', 'Драники', 'Сырники', 'Чизкейк классический',
    'Винегрет', 'Оливье', 'Сельдь под шубой', 'Рассольник', 'Щи из свежей капусты']) {
    assert.ok(isBatchDish({ title }), title + ' должен быть батчем');
  }
  // мясные рагу и соусы
  assert.ok(isBatchDish({ title: 'Гуляш', ingredients: [{ n: 'Говядина', a: '500 г' }] }));
  assert.ok(isBatchDish({ title: 'Бефстроганов', tags: ['meat'] }));
  assert.ok(isBatchDish({ title: 'Карри с курицей', ingredients: [{ n: 'Курица', a: '400 г' }] }));
  assert.ok(isBatchDish({ title: 'Мясной соус болоньезе', tags: ['meat'] }));
  // овощное карри без мяса — НЕ батч по правилу рагу
  assert.ok(!isBatchDish({ title: 'Овощи в соусе карри', tags: ['veggie'],
    ingredients: [{ n: 'Брокколи', a: '100 г' }] }));
  // супы с мясом и грибные
  assert.ok(isBatchDish({ title: 'Борщ', tags: ['soup'], ingredients: [{ n: 'Говядина', a: '400 г' }] }));
  assert.ok(isBatchDish({ title: 'Грибной суп', tags: ['soup'], ingredients: [{ n: 'Шампиньоны', a: '300 г' }] }));
  assert.ok(!isBatchDish({ title: 'Овощной суп', tags: ['soup'], ingredients: [{ n: 'Морковь', a: '2 шт' }] }));
  // мясо в томатном соусе
  assert.ok(isBatchDish({ title: 'Голубцы', tags: ['meat'],
    ingredients: [{ n: 'Индейка', a: '500 г' }, { n: 'Помидоры в собственном соку', a: '400 г' }] }));
  // обычные блюда — не батч
  assert.ok(!isBatchDish({ title: 'Запечённый лосось', tags: ['fish'], ingredients: [{ n: 'Лосось', a: '1 кг' }] }));
  assert.ok(!isBatchDish({ title: 'Овощной салат', tags: ['salad'], ingredients: [{ n: 'Огурец', a: '2 шт' }] }));
});

test('generateWeek: батч-блюдо занимает разогрев следующего дня', () => {
  const catalog = [
    { id: 'gulyash', title: 'Гуляш', tags: ['meat'], meta: '~90 мин',
      lastCookedAt: new Date(NOW - 60 * 86400000).toISOString(),
      ingredients: [{ n: 'Говядина', a: '500 г', qty: 500, unit: 'g', ing: 'говядина' }] },
    ...Array.from({ length: 8 }, (_, i) => ({
      id: `v${i}`, title: `Овощи ${i}`, tags: ['veggie'], meta: '~20 мин',
      ingredients: [{ n: `Овощ${i}`, a: '100 г' }] })),
  ];
  const profile = { planMeals: ['lunch', 'dinner'], rhythm: {}, members: [{ name: 'а', coeff: 1 }] };
  const slots = generateWeek(catalog, profile, {}, null, NOW, () => 0);
  // гуляш побеждает по давности → пн ужин? найдём его слот готовки
  const cookEntry = Object.entries(slots).find(([, s]) => s.recipeId === 'gulyash' && s.kind === 'batch');
  assert.ok(cookEntry, 'батч-слот готовки существует');
  const [cookId] = cookEntry;
  const reheatEntry = Object.entries(slots).find(([, s]) => s.kind === 'reheat');
  assert.ok(reheatEntry, 'слот разогрева существует');
  const [reheatId, reheat] = reheatEntry;
  assert.equal(reheat.recipeId, 'gulyash');
  assert.equal(reheat.linkedTo, cookId);
  // разогрев на следующий день, предпочтительно обед
  const [cd] = cookId.split('_'); const [rd, rm] = reheatId.split('_');
  assert.equal(DAYS.indexOf(rd), DAYS.indexOf(cd) + 1);
  assert.equal(rm, 'lunch');
});

test('aggregateShopping: разогрев не дублирует закупку, батч умножает', async () => {
  const { batchFactor } = await import('../js/planner.js');
  const profile = { members: [{ coeff: 1 }, { coeff: 1 }] }; // семья из 2 → нужно 2*2+1=5 порций
  const gulyash = { id: 'g', title: 'Гуляш', servings: 4,
    ingredients: [{ n: 'Говядина', a: '500 г', qty: 500, unit: 'g', ing: 'говядина' }] };
  assert.equal(batchFactor(gulyash, profile), 1.5); // 5/4 → 1.25 → шаг 0.5 вверх = 1.5
  const slots = {
    mon_dinner: { recipeId: 'g', kind: 'batch' },
    tue_lunch: { recipeId: 'g', kind: 'reheat', linkedTo: 'mon_dinner' },
  };
  const items = aggregateShopping(slots, { g: gulyash }, null, profile);
  const beef = items.find(i => i.key === 'говядина');
  assert.equal(Math.round(beef.grams), 750); // 500 × 1.5, разогрев не добавил
});

test('clearBatchLinks + applyBatchLink', async () => {
  const { clearBatchLinks, applyBatchLink } = await import('../js/planner.js');
  const gulyash = { id: 'g', title: 'Гуляш', tags: ['meat'], ingredients: [{ n: 'Говядина', a: '1 кг' }] };
  const profile = { planMeals: ['lunch', 'dinner'] };
  let slots = { mon_dinner: { recipeId: 'g', kind: 'batch' },
    tue_lunch: { recipeId: 'g', kind: 'reheat', linkedTo: 'mon_dinner' } };
  clearBatchLinks(slots, 'mon_dinner');
  assert.equal(slots.tue_lunch.recipeId, null);
  // связка не перетирает залоченный целевой слот
  slots = { mon_dinner: { recipeId: 'g' }, tue_lunch: { recipeId: 'other', locked: true } };
  applyBatchLink(slots, profile, 'mon_dinner', gulyash);
  assert.equal(slots.mon_dinner.kind, 'batch');
  assert.equal(slots.tue_lunch.recipeId, 'other', 'залоченный слот не тронут');
});

test('buildSlots: завтраки включаются в сетку', () => {
  const slots = buildSlots({ planMeals: ['breakfast', 'dinner'] });
  assert.equal(slots.length, 14);
  assert.deepEqual(slots.slice(0, 2).map(s => s.id), ['mon_breakfast', 'mon_dinner']);
});

test('findReheatSlotId: завтрак → завтрак, ужин → обед либо ужин, воскресенье → null', async () => {
  const { findReheatSlotId } = await import('../js/planner.js');
  assert.equal(findReheatSlotId({ planMeals: ['breakfast', 'lunch', 'dinner'] }, 'mon_breakfast'), 'tue_breakfast');
  assert.equal(findReheatSlotId({ planMeals: ['lunch', 'dinner'] }, 'mon_dinner'), 'tue_lunch');
  assert.equal(findReheatSlotId({ planMeals: ['dinner'] }, 'mon_dinner'), 'tue_dinner');
  assert.equal(findReheatSlotId({ planMeals: ['dinner'] }, 'sun_dinner'), null);
});
