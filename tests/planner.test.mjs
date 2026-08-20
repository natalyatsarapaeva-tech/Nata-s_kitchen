import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  weekStartISO, buildSlots, generateWeek, rerollSlot,
  aggregateShopping, shoppingAmountLabel, weekTotals, DAYS,
  baseWeekTarget, pickBaseSlotIds,
} from '../js/planner.js';
import { filterCandidates, proteinKey } from '../js/suggest.js';
import { buildDict } from '../js/nutrition-core.js';

const NOW = Date.parse('2026-07-18T18:00:00Z');

test('weekStartISO: понедельник недели', () => {
  assert.equal(weekStartISO(new Date('2026-07-18T12:00:00')), '2026-07-13'); // суббота → пн 13-е
  assert.equal(weekStartISO(new Date('2026-07-13T00:30:00')), '2026-07-13'); // сам понедельник
  assert.equal(weekStartISO(new Date('2026-07-19T23:00:00')), '2026-07-13'); // воскресенье → тот же пн
});

test('buildSlots: из настроек семьи', () => {
  assert.equal(buildSlots({ planMeals: ['dinner'], weekendFull: false }).length, 7);
  const both = buildSlots({ planMeals: ['lunch', 'dinner'], weekendFull: false });
  assert.equal(both.length, 14);
  assert.deepEqual(both.slice(0, 2).map(s => s.id), ['mon_lunch', 'mon_dinner']);
});

test('buildSlots: по умолчанию сб-вс планируют все три приёма', () => {
  const slots = buildSlots({ planMeals: ['dinner'] });
  assert.equal(slots.length, 11, '5 будних ужинов + 2×3 выходных');
  assert.ok(slots.some(s => s.id === 'sat_breakfast'));
  assert.ok(slots.some(s => s.id === 'sun_lunch'));
  assert.ok(!slots.some(s => s.id === 'mon_breakfast'), 'будни — только из planMeals');
  assert.equal(buildSlots({}).length, 11, 'дефолтный профиль — то же самое');
  assert.equal(buildSlots({ planMeals: ['breakfast', 'lunch', 'dinner'] }).length, 21);
});

const CATALOG = Array.from({ length: 10 }, (_, i) => ({
  id: `r${i}`, title: `Блюдо ${i}`, tags: ['veggie'], meta: '~30 мин',
  ingredients: [{ n: `Овощ${i}`, a: '100 г' }],
}));

test('generateWeek: заполняет все слоты без повторов', () => {
  const profile = { planMeals: ['dinner'], weekendFull: false, rhythm: {} };
  const slots = generateWeek(CATALOG, profile, {}, null, NOW, () => 0);
  const ids = Object.values(slots).map(s => s.recipeId);
  assert.equal(ids.length, 7);
  assert.ok(ids.every(Boolean));
  assert.equal(new Set(ids).size, 7, 'все блюда недели разные');
});

test('generateWeek: залоченные слоты сохраняются и участвуют в анти-повторах', () => {
  const profile = { planMeals: ['dinner'], weekendFull: false, rhythm: {} };
  const existing = { mon_dinner: { recipeId: 'r5', locked: true } };
  const slots = generateWeek(CATALOG, profile, existing, null, NOW, () => 0);
  assert.equal(slots.mon_dinner.recipeId, 'r5');
  assert.equal(slots.mon_dinner.locked, true);
  const others = Object.entries(slots).filter(([id]) => id !== 'mon_dinner').map(([, s]) => s.recipeId);
  assert.ok(!others.includes('r5'), 'закреплённое не дублируется в другие дни');
});

test('generateWeek: маленький каталог — повторы допустимы, слоты не пустуют', () => {
  const small = CATALOG.slice(0, 3);
  const slots = generateWeek(small, { planMeals: ['dinner'], weekendFull: false, rhythm: {} }, {}, null, NOW, () => 0);
  assert.ok(Object.values(slots).every(s => s.recipeId), 'все слоты заполнены за счёт второго круга');
});

test('generateWeek: бюджет времени дня и исключения семьи соблюдаются', () => {
  const catalog = [
    { id: 'slow', title: 'Долгое', tags: ['veggie'], meta: '~90 мин', ingredients: [{ n: 'Капуста', a: '1 шт' }] },
    { id: 'fast', title: 'Быстрое', tags: ['veggie'], meta: '~15 мин', ingredients: [{ n: 'Огурец', a: '2 шт' }] },
    { id: 'nuts', title: 'С орехами', tags: ['veggie'], meta: '~15 мин', ingredients: [{ n: 'Грецкие орехи', a: '100 г' }] },
  ];
  const profile = { planMeals: ['dinner'], weekendFull: false, rhythm: { mon: 20 }, exclude: ['орехи'] };
  const slots = generateWeek(catalog, profile, {}, null, NOW, () => 0);
  assert.equal(slots.mon_dinner.recipeId, 'fast'); // в 20 минут влезает только быстрое без орехов
  const all = Object.values(slots).map(s => s.recipeId);
  assert.ok(!all.includes('nuts'), 'исключённые продукты не попадают ни в один день');
});

test('rerollSlot: не предлагает текущее блюдо и занятые в других слотах', () => {
  const profile = { planMeals: ['dinner'], weekendFull: false, rhythm: {} };
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
  const profile = { planMeals: ['lunch', 'dinner'], weekendFull: false, rhythm: {}, members: [{ name: 'а', coeff: 1 }] };
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
  const slots = buildSlots({ planMeals: ['breakfast', 'dinner'], weekendFull: false });
  assert.equal(slots.length, 14);
  assert.deepEqual(slots.slice(0, 2).map(s => s.id), ['mon_breakfast', 'mon_dinner']);
});

test('findReheatSlotId: завтрак → завтрак, ужин → обед либо ужин, воскресенье → null', async () => {
  const { findReheatSlotId } = await import('../js/planner.js');
  assert.equal(findReheatSlotId({ planMeals: ['breakfast', 'lunch', 'dinner'] }, 'mon_breakfast'), 'tue_breakfast');
  assert.equal(findReheatSlotId({ planMeals: ['lunch', 'dinner'] }, 'mon_dinner'), 'tue_lunch');
  assert.equal(findReheatSlotId({ planMeals: ['dinner'] }, 'mon_dinner'), 'tue_dinner');
  assert.equal(findReheatSlotId({ planMeals: ['dinner'] }, 'sun_dinner'), null);
  // субботний батч при полных выходных разогревается в воскресный обед
  assert.equal(findReheatSlotId({ planMeals: ['dinner'] }, 'sat_dinner'), 'sun_lunch');
});

// ── Канонизация списка покупок ──
test('canonicalShoppingKey: модификаторы, «или», группы, alias', async () => {
  const { canonicalShoppingKey } = await import('../js/planner.js');
  assert.equal(canonicalShoppingKey('молоко тёплое', null), 'молоко');
  assert.equal(canonicalShoppingKey('тёплое молоко', null), 'молоко');
  assert.equal(canonicalShoppingKey('молоко или растительное молоко', null), 'молоко');
  assert.equal(canonicalShoppingKey('яйца', null), 'яйцо');
  assert.equal(canonicalShoppingKey('яйцо', null), 'яйцо');
  assert.equal(canonicalShoppingKey('яиц', null), 'яйцо');
  assert.equal(canonicalShoppingKey('яйца куриные', null), 'яйцо');
  // кокосовое молоко — отдельный товар, не сливается с молоком
  assert.equal(canonicalShoppingKey('кокосовое молоко', null), 'кокосовое молоко');
  // alias справочника («томаты черри» → «помидор»)
  const dict = buildDict({ 'помидор': { kcal: 20, protein: 1, fat: 0, carbs: 4, aliases: ['томаты черри'] } });
  assert.equal(canonicalShoppingKey('томаты черри', dict), 'помидор');
});

test('aggregateShopping: синонимы сливаются, яйца считаются штуками', () => {
  const recipes = {
    a: { id: 'a', ingredients: [
      { n: 'Яйца', a: '10 шт' },              // немигрировано: 600 г через unitG
      { n: 'Молоко тёплое', a: '500 мл' },
    ]},
    b: { id: 'b', ingredients: [
      { n: 'Яйцо', a: '150 г', qty: 150, unit: 'g', ing: 'яйцо' },
      { n: 'молоко (или растительное молоко)', a: '100 мл' },
      { n: 'Яйца', a: '2 шт', qty: 2, unit: 'pcs', ing: 'яйца' },
    ]},
  };
  const slots = { mon_dinner: { recipeId: 'a' }, tue_dinner: { recipeId: 'b' } };
  const items = aggregateShopping(slots, recipes, null);
  // одна строка яиц, одна строка молока
  const eggs = items.filter(i => i.key === 'яйцо');
  assert.equal(eggs.length, 1, 'яйца слиты в одну позицию');
  // 600г + 150г = 750г → 12.5 шт + 2 шт → потолок 15
  assert.equal(shoppingAmountLabel(eggs[0]), '15 шт');
  const milk = items.filter(i => i.key === 'молоко');
  assert.equal(milk.length, 1, 'молоко слито в одну позицию');
  assert.equal(Math.round(milk[0].grams), 600);
  assert.ok(milk[0].label.toLowerCase().startsWith('молоко'), 'короткое написание как ярлык: ' + milk[0].label);
});

// ── Квоты ужинов и чередование сытности ──
test('proteinClass: мясо / рыба / вегетарианское', async () => {
  const { proteinClass } = await import('../js/suggest.js');
  assert.equal(proteinClass({ ingredients: [{ n: 'Говядина', a: '500 г' }] }), 'meat');
  assert.equal(proteinClass({ ingredients: [{ n: 'Куриная грудка', a: '400 г' }] }), 'meat');
  assert.equal(proteinClass({ ingredients: [{ n: 'Лосось', a: '300 г' }] }), 'fish');
  assert.equal(proteinClass({ tags: ['veggie'], ingredients: [{ n: 'Кабачок', a: '1 шт' }] }), 'veg');
});

const QUOTA_CATALOG = [
  // мясные: средний (борщ) и сытные (гуляш, жаркое)
  { id: 'borsch', title: 'Борщ', tags: ['soup'], meta: '~60 мин',
    ingredients: [{ n: 'Говядина', a: '400 г' }, { n: 'Свёкла', a: '2 шт' }] },
  { id: 'gulyash', title: 'Гуляш', tags: ['meat'], meta: '~90 мин',
    ingredients: [{ n: 'Говядина', a: '500 г' }] },
  { id: 'roast', title: 'Жаркое', tags: ['meat'], meta: '~80 мин',
    ingredients: [{ n: 'Свинина', a: '600 г' }] },
  // рыба
  { id: 'salmon', title: 'Лосось запечённый', tags: ['fish'], meta: '~25 мин',
    ingredients: [{ n: 'Лосось', a: '600 г' }] },
  { id: 'cod', title: 'Треска с овощами', tags: ['fish'], meta: '~30 мин',
    ingredients: [{ n: 'Треска', a: '500 г' }] },
  // вег
  { id: 'veg1', title: 'Овощная сковорода', tags: ['veggie'], meta: '~25 мин',
    ingredients: [{ n: 'Кабачок', a: '2 шт' }] },
  { id: 'veg2', title: 'Тушёная капуста', tags: ['veggie'], meta: '~35 мин',
    ingredients: [{ n: 'Капуста', a: '1 шт' }] },
  { id: 'veg3', title: 'Печёные овощи', tags: ['veggie'], meta: '~40 мин',
    ingredients: [{ n: 'Баклажан', a: '2 шт' }] },
];

test('generateWeek: квоты ужинов соблюдаются (разогрев батча тоже расходует квоту)', async () => {
  const { proteinClass } = await import('../js/suggest.js');
  const profile = { planMeals: ['dinner'], weekendFull: false, rhythm: {},
    dinnerQuota: { meat: 3, fish: 2, veg: 2 } };
  const slots = generateWeek(QUOTA_CATALOG, profile, {}, null, NOW, () => 0);
  const byId = {}; QUOTA_CATALOG.forEach(r => byId[r.id] = r);
  const entries = DAYS.map(d => slots[`${d}_dinner`]);
  const classes = entries.map(s => proteinClass(byId[s.recipeId] || {}));
  const count = c => classes.filter(x => x === c).length;
  assert.equal(count('meat'), 3, 'мясных ужинов (включая разогрев) ровно 3: ' + classes.join(','));
  assert.equal(count('fish'), 2, 'рыбных 2');
  assert.equal(count('veg'), 2, 'вегетарианских 2');
  // классы не повторяются подряд — кроме разогрева батча (это то же блюдо)
  for (let i = 1; i < classes.length; i++) {
    if (entries[i].kind === 'reheat') continue;
    assert.notEqual(classes[i], classes[i - 1], `подряд одинаковые: ${classes.join(',')}`);
  }
});

test('generateWeek: свежие мясные ужины чередуются средний → сытный', async () => {
  const { effectiveHeaviness } = await import('../js/suggest.js');
  const profile = { planMeals: ['dinner'], weekendFull: false, rhythm: {},
    dinnerQuota: { meat: 3, fish: 2, veg: 2 } };
  const slots = generateWeek(QUOTA_CATALOG, profile, {}, null, NOW, () => 0);
  const byId = {}; QUOTA_CATALOG.forEach(r => byId[r.id] = r);
  // только слоты готовки (не разогревы), только мясные
  const meatHeavies = DAYS
    .map(d => slots[`${d}_dinner`])
    .filter(s => s.kind !== 'reheat' && ['borsch', 'gulyash', 'roast'].includes(s.recipeId))
    .map(s => effectiveHeaviness(byId[s.recipeId]));
  assert.ok(meatHeavies.length >= 2, 'есть минимум два свежих мясных ужина');
  assert.equal(meatHeavies[0], 'medium', 'первый мясной ужин средний: ' + meatHeavies.join(','));
  assert.equal(meatHeavies[1], 'heavy', 'второй мясной — сытный');
});

test('generateWeek: залоченный мясной ужин расходует квоту', async () => {
  const { proteinClass } = await import('../js/suggest.js');
  const profile = { planMeals: ['dinner'], weekendFull: false, rhythm: {},
    dinnerQuota: { meat: 1, fish: 0, veg: 6 } };
  const existing = { wed_dinner: { recipeId: 'gulyash', locked: true } };
  const slots = generateWeek(QUOTA_CATALOG, profile, existing, null, NOW, () => 0);
  const byId = {}; QUOTA_CATALOG.forEach(r => byId[r.id] = r);
  const meatCount = DAYS.filter(d =>
    proteinClass(byId[slots[`${d}_dinner`].recipeId] || {}) === 'meat').length;
  assert.equal(meatCount, 1, 'единственный мясной — залоченный гуляш');
});

test('generateWeek: квота на класс без кандидатов честно откатывается', () => {
  const noFish = QUOTA_CATALOG.filter(r => !['salmon', 'cod'].includes(r.id));
  const profile = { planMeals: ['dinner'], weekendFull: false, rhythm: {}, dinnerQuota: { meat: 2, fish: 3, veg: 2 } };
  const slots = generateWeek(noFish, profile, {}, null, NOW, () => 0);
  assert.ok(Object.values(slots).every(s => s.recipeId), 'слоты заполнены несмотря на невыполнимую рыбную квоту');
});

test('rerollSlot: сохраняет класс белка текущего блюда', () => {
  const profile = { planMeals: ['dinner'], weekendFull: false, rhythm: {} };
  const slots = { mon_dinner: { recipeId: 'salmon' } };
  const next = rerollSlot(QUOTA_CATALOG, profile, slots, 'mon_dinner', null, NOW, () => 0);
  assert.equal(next.recipeId, 'cod', 'рыбный ужин остаётся рыбным');
});

// ── Регулярные блюда как основа недели ──

const MIXED_CATALOG = [
  ...Array.from({ length: 6 }, (_, i) => ({
    id: `base${i}`, title: `Базовое ${i}`, tags: ['veggie'], meta: '~30 мин',
    ingredients: [{ n: `Овощ${i}`, a: '100 г' }],
  })),
  ...Array.from({ length: 6 }, (_, i) => ({
    id: `reg${i}`, title: `Привычное ${i}`, tags: ['veggie', 'regular'], meta: '~20 мин',
    ingredients: [{ n: `Крупа${i}`, a: '100 г' }],
  })),
];

test('baseWeekTarget: 2–4 базовых на неделю', () => {
  assert.equal(baseWeekTarget(7), 2);   // только ужины
  assert.equal(baseWeekTarget(14), 4);  // обеды + ужины (round(14/3)=5 → максимум 4)
  assert.equal(baseWeekTarget(21), 4);  // все приёмы
  assert.equal(baseWeekTarget(1), 1);   // не больше, чем слотов
  assert.equal(baseWeekTarget(0), 0);
});

test('pickBaseSlotIds: равномерно по свободным слотам', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  assert.deepEqual([...pickBaseSlotIds(ids, 2)], ['b', 'f']);
  assert.deepEqual([...pickBaseSlotIds(ids, 0)], []);
  assert.equal(pickBaseSlotIds(['a'], 5).size, 1, 'не больше, чем слотов');
});

test('generateWeek: регулярные — основа, базовых ровно по лимиту', () => {
  const profile = { planMeals: ['dinner'], weekendFull: false, rhythm: {} };
  const slots = generateWeek(MIXED_CATALOG, profile, {}, null, NOW, () => 0);
  const ids = Object.values(slots).map(s => s.recipeId);
  assert.ok(ids.every(Boolean), 'все слоты заполнены');
  const baseCount = ids.filter(id => id.startsWith('base')).length;
  assert.equal(baseCount, 2, 'на 7 ужинов — 2 базовых блюда');
  assert.equal(ids.filter(id => id.startsWith('reg')).length, 5, 'остальные — регулярные');
});

test('generateWeek: залоченные базовые расходуют базовый лимит', () => {
  const profile = { planMeals: ['dinner'], weekendFull: false, rhythm: {} };
  const existing = {
    mon_dinner: { recipeId: 'base0', locked: true },
    thu_dinner: { recipeId: 'base1', locked: true },
  };
  const slots = generateWeek(MIXED_CATALOG, profile, existing, null, NOW, () => 0);
  const generated = Object.entries(slots)
    .filter(([id]) => id !== 'mon_dinner' && id !== 'thu_dinner')
    .map(([, s]) => s.recipeId);
  assert.ok(generated.every(id => id.startsWith('reg')),
    'лимит выбран локами — генерация добавляет только регулярные: ' + generated.join(','));
});

test('generateWeek: без регулярных в каталоге поведение прежнее', () => {
  const baseOnly = MIXED_CATALOG.filter(r => r.id.startsWith('base'));
  const slots = generateWeek(baseOnly, { planMeals: ['dinner'], weekendFull: false, rhythm: {} }, {}, null, NOW, () => 0);
  assert.ok(Object.values(slots).every(s => s.recipeId), 'неделя строится целиком из базы');
});

test('generateWeek: мало регулярных — честный fallback в базу, слоты не пустуют', () => {
  const catalog = [...MIXED_CATALOG.filter(r => r.id.startsWith('base')), MIXED_CATALOG[6]]; // 6 базовых + 1 регулярное
  const slots = generateWeek(catalog, { planMeals: ['dinner'], weekendFull: false, rhythm: {} }, {}, null, NOW, () => 0);
  const ids = Object.values(slots).map(s => s.recipeId);
  assert.ok(ids.every(Boolean), 'все слоты заполнены');
  assert.ok(ids.includes('reg0'), 'единственное регулярное блюдо использовано');
});

// ── Один белковый приём не готовим свежим несколько раз за неделю ──
// Комбо-рецепт «Белок + гарнир»: одна и та же белая рыба на пару с разными
// гарнирами — это один белковый приём, а не четыре разных блюда.
function combo(id, protein, side, cls) {
  return {
    id, title: `${protein} + ${side}`, tags: ['regular'], meta: '~30 мин',
    combo: { protein }, attrs: { mealType: ['lunch', 'dinner'], mainProtein: cls },
    ingredients: [{ n: protein, a: '300 г' }, { n: side, a: '200 г' }],
  };
}

const COMBO_CATALOG = [
  combo('f-gr', 'Белая рыба на пару', 'Гречка', 'fish'),
  combo('f-ka', 'Белая рыба на пару', 'Картошка', 'fish'),
  combo('f-ri', 'Белая рыба на пару', 'Рис', 'fish'),
  combo('f-cap', 'Белая рыба на пару', 'Капуста', 'fish'),
  combo('c-gr', 'Курица', 'Гречка', 'chicken'),
  combo('c-ka', 'Курица', 'Картошка', 'chicken'),
  combo('ind', 'Индейка', 'Рис', 'chicken'),
  combo('kot', 'Котлеты', 'Гречка', 'beef'),
  combo('svin', 'Свинина', 'Картошка', 'pork'),
  combo('fas', 'Рагу из фасоли', 'Капуста', 'legumes'),
  combo('gov', 'Стейк из говядины', 'Гречка', 'beef'),
  combo('egg', 'Омлет', 'Овощи', 'none'),
];

test('proteinKey: комбо → белковая часть, обычный рецепт → null', () => {
  assert.equal(proteinKey(COMBO_CATALOG[0]), 'белая рыба на пару');
  assert.equal(proteinKey({ id: 'x', title: 'Суп' }), null);
});

test('generateWeek: один белок не повторяется свежим (глюк 4× рыбы)', () => {
  const profile = { planMeals: ['dinner'], weekendFull: false, rhythm: {} };
  const slots = generateWeek(COMBO_CATALOG, profile, {}, null, NOW, () => 0);
  const byId = Object.fromEntries(COMBO_CATALOG.map(r => [r.id, r]));
  const counts = {};
  for (const s of Object.values(slots)) {
    if (!s.recipeId || s.kind === 'reheat') continue;
    const pk = proteinKey(byId[s.recipeId]);
    counts[pk] = (counts[pk] || 0) + 1;
  }
  assert.ok(Object.values(slots).every(s => s.recipeId), 'все 7 слотов заполнены');
  // 10 белковых групп-приёмов на 7 слотов — каждый белок свежим не больше раза
  assert.equal(counts['белая рыба на пару'], 1, 'рыба ровно один раз, не 4');
  assert.ok(Object.values(counts).every(c => c <= 1),
    'ни один белковый приём не повторяется свежим: ' + JSON.stringify(counts));
});

test('generateWeek: только один белок в каталоге — слоты не пустуют (резерв)', () => {
  const onlyFish = COMBO_CATALOG.filter(r => r.id.startsWith('f-'));
  const profile = { planMeals: ['dinner'], weekendFull: false, rhythm: {} };
  const slots = generateWeek(onlyFish, profile, {}, null, NOW, () => 0);
  assert.ok(Object.values(slots).every(s => s.recipeId),
    'когда альтернатив нет, ограничение снимается и дыр в меню не остаётся');
});

test('rerollSlot: не подставляет белок, уже занятый в других слотах', () => {
  const profile = { planMeals: ['dinner'], weekendFull: false, rhythm: {} };
  // почти вся неделя — курица/индейка/мясо/фасоль; свободный слот не должен
  // стать рыбой, если рыба уже стоит в другом слоте
  const slots = {
    mon_dinner: { recipeId: 'f-gr' }, // белая рыба уже здесь
    tue_dinner: { recipeId: 'c-gr' },
  };
  const next = rerollSlot(COMBO_CATALOG, profile, slots, 'wed_dinner', null, NOW, () => 0);
  assert.notEqual(proteinKey(COMBO_CATALOG.find(r => r.id === next.recipeId)),
    'белая рыба на пару', 'рыбу второй раз свежей не ставим');
});

test('rerollSlot: происхождение блюда сохраняется', () => {
  const profile = { planMeals: ['dinner'], weekendFull: false, rhythm: {} };
  const next = rerollSlot(MIXED_CATALOG, profile,
    { mon_dinner: { recipeId: 'reg0' } }, 'mon_dinner', null, NOW, () => 0);
  assert.ok(next.recipeId.startsWith('reg'), 'регулярное меняется на регулярное');
  const nextBase = rerollSlot(MIXED_CATALOG, profile,
    { mon_dinner: { recipeId: 'base0' } }, 'mon_dinner', null, NOW, () => 0);
  assert.ok(nextBase.recipeId.startsWith('base'), 'базовое меняется на базовое');
  const nextEmpty = rerollSlot(MIXED_CATALOG, profile, {}, 'mon_dinner', null, NOW, () => 0);
  assert.ok(nextEmpty.recipeId.startsWith('reg'), 'пустой слот пополняется из регулярных');
});
