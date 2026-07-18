import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mealTypeFromClock, mealTypesForRecipe, recipeMinutes,
  effectiveHeaviness, filterCandidates, scoreRecipe, pickWeighted, pickSuggestion,
  whyLine, isSimilar, similarInCatalog, catalogDigest
} from '../js/suggest.js';
import { buildDict } from '../js/nutrition-core.js';

const DAY = 86400000;
const NOW = Date.parse('2026-07-18T18:00:00Z');
const daysAgo = n => new Date(NOW - n * DAY).toISOString();

test('mealTypeFromClock: завтрак/обед/ужин по часам', () => {
  assert.equal(mealTypeFromClock(8), 'breakfast');
  assert.equal(mealTypeFromClock(10), 'breakfast');
  assert.equal(mealTypeFromClock(11), 'lunch');
  assert.equal(mealTypeFromClock(15), 'lunch');
  assert.equal(mealTypeFromClock(16), 'dinner');
  assert.equal(mealTypeFromClock(21), 'dinner');
});

test('mealTypesForRecipe: attrs в приоритете, fallback на теги', () => {
  assert.deepEqual(mealTypesForRecipe({ attrs: { mealType: ['dinner'] }, tags: ['baking'] }), ['dinner']);
  assert.deepEqual(mealTypesForRecipe({ tags: ['soup'] }), ['lunch', 'dinner']);
  assert.deepEqual(mealTypesForRecipe({ tags: ['dessert'] }), ['dessert', 'snack']);
  // без тегов — не исключаем ниоткуда
  assert.deepEqual(mealTypesForRecipe({}), ['breakfast', 'lunch', 'dinner']);
});

test('десерты и выпечка не попадают в ужин через fallback', () => {
  assert.ok(!mealTypesForRecipe({ tags: ['dessert'] }).includes('dinner'));
  assert.ok(!mealTypesForRecipe({ tags: ['baking'] }).includes('dinner'));
});

test('recipeMinutes: attrs.totalMin, потом парсинг meta', () => {
  assert.equal(recipeMinutes({ attrs: { totalMin: 25 } }), 25);
  assert.equal(recipeMinutes({ meta: '~30 мин · 4 порции' }), 30);
  assert.equal(recipeMinutes({ meta: '200°С · 35–40 мин' }), 40);
  assert.equal(recipeMinutes({ meta: '150°С · 2,5–3 часа' }), 180);
  assert.equal(recipeMinutes({ meta: 'вьетнамские' }), null);
  assert.equal(recipeMinutes({}), null);
});

const CATALOG = [
  { id: 'soup', title: 'Суп', tags: ['soup'], meta: '~30 мин', lastCookedAt: daysAgo(30) },
  { id: 'fresh', title: 'Салат', tags: ['salad'], meta: '~15 мин', lastCookedAt: daysAgo(2) },
  { id: 'never', title: 'Новое', tags: ['meat'], meta: '~60 мин' },
  { id: 'heavy', title: 'Жаркое', tags: ['meat'], meta: '~40 мин',
    attrs: { heaviness: 'heavy' }, lastCookedAt: daysAgo(40) },
  { id: 'cake', title: 'Торт', tags: ['dessert'], meta: '~90 мин' },
];

test('effectiveHeaviness: супы — без мяса лёгкие, с мясом средние, с мясом и бобовыми сытные', () => {
  // овощной суп → лёгкий
  assert.equal(effectiveHeaviness({ tags: ['soup'], ingredients: [
    { n: 'Морковь', a: '2 шт' }, { n: 'Картофель', a: '3 шт' }] }), 'light');
  // суп с креветками: рыба/морепродукты — не мясо → лёгкий
  assert.equal(effectiveHeaviness({ tags: ['soup', 'fish'], ingredients: [
    { n: 'Креветки', a: '500 г' }, { n: 'Помидоры', a: '700 г' }] }), 'light');
  // борщ с говядиной, без бобовых → средний (правило супов сильнее правила говядины)
  assert.equal(effectiveHeaviness({ tags: ['soup'], ingredients: [
    { n: 'Говядина', a: '400 г' }, { n: 'Свёкла', a: '2 шт' }] }), 'medium');
  // куриный суп → средний
  assert.equal(effectiveHeaviness({ tags: ['soup'], ingredients: [
    { n: 'Куриное филе', a: '300 г' }] }), 'medium');
  // гороховый суп со свининой → сытный
  assert.equal(effectiveHeaviness({ tags: ['soup'], ingredients: [
    { n: 'Свинина', a: '300 г' }, { n: 'Горох', a: '200 г' }] }), 'heavy');
  // суп с курицей и чечевицей → сытный
  assert.equal(effectiveHeaviness({ tags: ['soup'], ingredients: [
    { n: 'Курица', a: '300 г' }, { n: 'Чечевица', a: '150 г' }] }), 'heavy');
  // вегетарианский чечевичный суп: бобовые без мяса → лёгкий
  assert.equal(effectiveHeaviness({ tags: ['soup'], ingredients: [
    { n: 'Чечевица', a: '200 г' }, { n: 'Лук', a: '1 шт' }] }), 'light');
});

test('effectiveHeaviness: салаты — без мяса лёгкие, с любым мясом средние', () => {
  assert.equal(effectiveHeaviness({ tags: ['salad'], ingredients: [
    { n: 'Огурец', a: '2 шт' }, { n: 'Помидор', a: '2 шт' }] }), 'light');
  // салат с тунцом: рыба — не мясо → лёгкий
  assert.equal(effectiveHeaviness({ tags: ['salad'], ingredients: [
    { n: 'Тунец', a: '150 г' }, { n: 'Листья салата', a: '100 г' }] }), 'light');
  // цезарь с курицей → средний
  assert.equal(effectiveHeaviness({ tags: ['salad'], ingredients: [
    { n: 'Куриная грудка', a: '200 г' }] }), 'medium');
  // салат с беконом → средний (правило салатов сильнее правила бекона)
  assert.equal(effectiveHeaviness({ tags: ['salad'], ingredients: [
    { n: 'Бекон', a: '100 г' }] }), 'medium');
});

test('effectiveHeaviness: тяжёлое мясо и паста → сытное', () => {
  // колбаски → сытное
  assert.equal(effectiveHeaviness({ tags: ['meat'], ingredients: [
    { n: 'Сырые колбаски', a: '4 шт' }, { n: 'Яблоки', a: '2 шт' }] }), 'heavy');
  // гуляш из говядины → сытное
  assert.equal(effectiveHeaviness({ tags: ['meat'], ingredients: [
    { n: 'Говядина', a: '500 г' }] }), 'heavy');
  // свинина, бекон, фарш → сытное
  assert.equal(effectiveHeaviness({ ingredients: [{ n: 'Свинина', a: '300 г' }] }), 'heavy');
  assert.equal(effectiveHeaviness({ ingredients: [{ n: 'Бекон', a: '100 г' }] }), 'heavy');
  assert.equal(effectiveHeaviness({ ingredients: [{ n: 'Фарш бараний', a: '600 г' }] }), 'heavy');
  // куриные бёдра и ножки → сытное; грудка — нет
  assert.equal(effectiveHeaviness({ ingredients: [{ n: 'Куриные бёдра', a: '6 шт' }] }), 'heavy');
  assert.equal(effectiveHeaviness({ ingredients: [{ n: 'Утиные ножки', a: '2 шт' }] }), 'heavy');
  // любая паста → сытное
  assert.equal(effectiveHeaviness({ ingredients: [{ n: 'Спагетти', a: '200 г' }] }), 'heavy');
  assert.equal(effectiveHeaviness({ ingredients: [{ n: 'Листы лазаньи', a: '12 шт' }] }), 'heavy');
  assert.equal(effectiveHeaviness({ tags: ['pasta'] }), 'heavy');
  // attrs mainProtein тоже триггерит без ингредиентов
  assert.equal(effectiveHeaviness({ attrs: { mainProtein: 'pork', heaviness: 'light' } }), 'heavy');
});

test('effectiveHeaviness: рыба и грудка птицы → среднее', () => {
  assert.equal(effectiveHeaviness({ tags: ['fish'], ingredients: [
    { n: 'Филе лосося', a: '1 кг' }] }), 'medium');
  assert.equal(effectiveHeaviness({ ingredients: [{ n: 'Куриная грудка', a: '400 г' }] }), 'medium');
  assert.equal(effectiveHeaviness({ ingredients: [{ n: 'Грудка индейки', a: '500 г' }] }), 'medium');
  assert.equal(effectiveHeaviness({ attrs: { mainProtein: 'seafood' } }), 'medium');
  // прочая курица (крылья) — не грудка и не бёдра → среднее
  assert.equal(effectiveHeaviness({ tags: ['chicken'], ingredients: [
    { n: 'Куриные крылья', a: '1 кг' }] }), 'medium');
});

test('effectiveHeaviness: овощное и молочное — лёгкое; выпечка — нет', () => {
  assert.equal(effectiveHeaviness({ tags: ['veggie'], ingredients: [
    { n: 'Творог', a: '300 г' }, { n: 'Помидор', a: '1 шт' }] }), 'light');
  assert.equal(effectiveHeaviness({ attrs: { mainProtein: 'dairy' } }), 'light');
  assert.equal(effectiveHeaviness({ tags: ['baking'], attrs: { mainProtein: 'none' } }), 'medium');
});

test('effectiveHeaviness: калории на порцию переопределяют класс', () => {
  const dict = buildDict({
    'лосось': { kcal: 208, protein: 20, fat: 13, carbs: 0 },
    'сливочное масло': { kcal: 717, protein: 0.8, fat: 81, carbs: 0.1 },
    'огурец': { kcal: 15, protein: 0.7, fat: 0.1, carbs: 3, unitG: 100 },
  });
  // рыба в масле: >550 ккал/порц → сытное, хотя рыба «средняя»
  const fatty = { tags: ['fish'], servings: 1, ingredients: [
    { n: 'Лосось', a: '300 г', qty: 300, unit: 'g', ing: 'лосось' },
    { n: 'Сливочное масло', a: '100 г', qty: 100, unit: 'g', ing: 'сливочное масло' },
  ]};
  assert.equal(effectiveHeaviness(fatty, dict), 'heavy');
  // обычная порция рыбы → среднее (правило 5)
  const lean = { tags: ['fish'], servings: 2, ingredients: [
    { n: 'Лосось', a: '300 г', qty: 300, unit: 'g', ing: 'лосось' },
  ]};
  assert.equal(effectiveHeaviness(lean, dict), 'medium');
  // лёгкий салат остаётся лёгким при известных низких калориях
  const salad = { tags: ['salad'], servings: 2, ingredients: [
    { n: 'Огурец', a: '2 шт', qty: 2, unit: 'pcs', ing: 'огурец' },
  ]};
  assert.equal(effectiveHeaviness(salad, dict), 'light');
});

test('десерты и мороженое никогда не попадают в выдачу', () => {
  const catalog = [
    { id: 'cake', title: 'Торт', tags: ['dessert'], attrs: { mealType: ['breakfast'] } },
    { id: 'ice', title: 'Мороженое', tags: ['icecream'] },
    { id: 'pie', title: 'Пирог', tags: ['baking'] },
  ];
  // даже на завтрак и даже с mealType breakfast в attrs
  const breakfast = filterCandidates(catalog, { meal: 'breakfast' });
  assert.deepEqual(breakfast.map(r => r.id), ['pie']); // выпечка допустима, десерты — нет
  assert.equal(pickSuggestion([catalog[0], catalog[1]], {}, [], NOW, () => 0), null);
});

test('filterCandidates: приём пищи, время, строгая сытность', () => {
  const dinner = filterCandidates(CATALOG, { meal: 'dinner' });
  assert.deepEqual(dinner.map(r => r.id), ['soup', 'fresh', 'never', 'heavy']);
  // лимит времени: без известного времени — исключаются
  const quick = filterCandidates(CATALOG, { meal: 'dinner', maxMin: 30 });
  assert.deepEqual(quick.map(r => r.id), ['soup', 'fresh']);
  // полегче — строго: безмясной суп и салат; мясное «never» не проходит
  const light = filterCandidates(CATALOG, { meal: 'dinner', mood: 'light' });
  assert.deepEqual(light.map(r => r.id), ['soup', 'fresh']);
  // обычное — немигрированное мясо без тяжёлых сигналов
  const normal = filterCandidates(CATALOG, { meal: 'dinner', mood: 'normal' });
  assert.deepEqual(normal.map(r => r.id), ['never']);
  // сытное — только heavy (метка GPT утяжеляет)
  const hearty = filterCandidates(CATALOG, { meal: 'dinner', mood: 'hearty' });
  assert.deepEqual(hearty.map(r => r.id), ['heavy']);
});

test('scoreRecipe: давность доминирует, недавнее штрафуется', () => {
  const old = scoreRecipe({ lastCookedAt: daysAgo(30) }, NOW);
  const recent = scoreRecipe({ lastCookedAt: daysAgo(2) }, NOW);
  const never = scoreRecipe({}, NOW);
  assert.ok(old > never, 'давно готовленное выше нового');
  assert.ok(never > recent, 'новое выше недавнего');
  assert.ok(recent < 15, 'недавнее сильно оштрафовано');
  // лёгкий буст за проверенность
  assert.ok(scoreRecipe({ lastCookedAt: daysAgo(30), timesCooked: 5 }, NOW) >
            scoreRecipe({ lastCookedAt: daysAgo(30) }, NOW));
});

test('pickWeighted: детерминирован при фиксированном rand', () => {
  const scored = [
    { recipe: { id: 'a' }, score: 100 },
    { recipe: { id: 'b' }, score: 50 },
    { recipe: { id: 'c' }, score: 10 },
  ];
  assert.equal(pickWeighted(scored, () => 0).recipe.id, 'a');
  assert.equal(pickWeighted(scored, () => 0.99).recipe.id, 'c');
});

test('pickSuggestion: базовый подбор и исключение показанных', () => {
  const res = pickSuggestion(CATALOG, { meal: 'dinner' }, [], NOW, () => 0);
  // 30 и 40 дней оба упираются в потолок давности — любой из них валиден
  assert.ok(['soup', 'heavy'].includes(res.recipe.id));
  assert.equal(res.relaxed, null);
  const res2 = pickSuggestion(CATALOG, { meal: 'dinner' }, ['heavy'], NOW, () => 0);
  assert.notEqual(res2.recipe.id, 'heavy');
});

test('pickSuggestion: сытность никогда не ослабляется', () => {
  // только мясное heavy, а выбрано «полегче» → честный null, а не подмена
  const onlyHeavy = [CATALOG[3]];
  assert.equal(pickSuggestion(onlyHeavy, { meal: 'dinner', mood: 'light' }, [], NOW, () => 0), null);
  // исчерпали лёгкое рероллами → второй круг ТОЛЬКО по лёгкому, мясо не подсовывается
  const r1 = pickSuggestion(CATALOG, { meal: 'dinner', mood: 'light' }, ['soup', 'fresh'], NOW, () => 0);
  assert.ok(['soup', 'fresh'].includes(r1.recipe.id));
  assert.equal(r1.relaxed, 'repeat');
});

test('pickSuggestion: ослабление времени сохраняет сытность', () => {
  // ничего не влезает в 10 минут → relaxed:time
  const r2 = pickSuggestion(CATALOG, { meal: 'dinner', maxMin: 10 }, [], NOW, () => 0);
  assert.ok(r2.recipe);
  assert.equal(r2.relaxed, 'time');
  // время ослабили, но «полегче» удержали: только лёгкие кандидаты
  const r3 = pickSuggestion(CATALOG, { meal: 'dinner', maxMin: 10, mood: 'light' }, [], NOW, () => 0);
  assert.ok(['soup', 'fresh'].includes(r3.recipe.id));
  assert.equal(r3.relaxed, 'time');
  // всё показано → второй круг
  const shown = ['soup', 'fresh', 'never', 'heavy'];
  const r4 = pickSuggestion(CATALOG, { meal: 'dinner' }, shown, NOW, () => 0);
  assert.ok(r4.recipe);
  assert.equal(r4.relaxed, 'repeat');
  // пустой каталог → null
  assert.equal(pickSuggestion([], { meal: 'dinner' }, [], NOW, () => 0), null);
});

test('whyLine: человеческие формулировки', () => {
  assert.match(whyLine({}, NOW), /ни разу/);
  assert.match(whyLine({ lastCookedAt: daysAgo(21) }, NOW), /3 нед/);
  assert.match(whyLine({ lastCookedAt: daysAgo(6) }, NOW), /6 дн/);
  assert.match(whyLine({ lastCookedAt: daysAgo(0.2) }, NOW), /сегодня/);
});

test('isSimilar: похожесть по названию', () => {
  assert.ok(isSimilar({ title: 'Лазанья болоньезе классическая' }, { title: 'Лазанья болоньезе' }));
  assert.ok(!isSimilar({ title: 'Том ям с креветками' }, { title: 'Борщ украинский' }));
});

test('isSimilar: похожесть по основным ингредиентам, staples не считаются', () => {
  const mine = { title: 'Паста А', ingredients: [
    { n: 'Спагетти', a: '200 г' }, { n: 'Бекон', a: '100 г' },
    { n: 'Яйца', a: '2 шт' }, { n: 'Пармезан', a: '50 г' },
    { n: 'Соль', a: 'щепотка' }, { n: 'Оливковое масло', a: '1 ст. л.' } ] };
  const candidate = { title: 'Совсем другое название', ingredients: [
    { n: 'Спагетти', a: '250 г' }, { n: 'Бекон', a: '150 г' },
    { n: 'Яйца', a: '3 шт' }, { n: 'Пармезан', a: '60 г' } ] };
  assert.ok(isSimilar(candidate, mine));
  const different = { title: 'Другое', ingredients: [
    { n: 'Рис', a: '200 г' }, { n: 'Курица', a: '300 г' }, { n: 'Карри', a: '1 ст. л.' } ] };
  assert.ok(!isSimilar(different, mine));
});

test('similarInCatalog + catalogDigest', () => {
  const found = similarInCatalog({ title: 'Суп' }, CATALOG);
  assert.equal(found?.id, 'soup');
  assert.equal(similarInCatalog({ title: 'Рамен' }, CATALOG), null);
  const digest = catalogDigest([
    { title: 'Суп', attrs: { mainProtein: 'chicken', cuisine: 'русская' } },
    { title: 'Торт' },
  ]);
  assert.equal(digest, 'Суп · chicken · русская\nТорт');
});
