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

test('effectiveHeaviness: мясо никогда не лёгкое, даже без разметки', () => {
  // колбаски: немигрированный мясной рецепт → обычное, не лёгкое
  assert.equal(effectiveHeaviness({ tags: ['meat'] }), 'medium');
  // гуляш/фрикадельки: мясо с меткой medium → обычное
  assert.equal(effectiveHeaviness({ tags: ['meat'], attrs: { mainProtein: 'beef', heaviness: 'medium' } }), 'medium');
  // жаркое с меткой heavy → сытное
  assert.equal(effectiveHeaviness({ tags: ['meat'], attrs: { heaviness: 'heavy' } }), 'heavy');
  // GPT ошибочно назвал свинину лёгкой — правила не пускают
  assert.equal(effectiveHeaviness({ attrs: { mainProtein: 'pork', heaviness: 'light' } }), 'medium');
  // курица — не лёгкое по определению пользователя
  assert.equal(effectiveHeaviness({ tags: ['chicken'] }), 'medium');
});

test('effectiveHeaviness: лёгкое — овощи/молочное/рыба/морепродукты', () => {
  assert.equal(effectiveHeaviness({ tags: ['salad'] }), 'light');
  assert.equal(effectiveHeaviness({ tags: ['veggie'] }), 'light');
  assert.equal(effectiveHeaviness({ tags: ['fish'] }), 'light');
  assert.equal(effectiveHeaviness({ attrs: { mainProtein: 'seafood' } }), 'light');
  assert.equal(effectiveHeaviness({ attrs: { mainProtein: 'dairy' } }), 'light');
  // но метка medium от GPT уважается
  assert.equal(effectiveHeaviness({ tags: ['fish'], attrs: { mainProtein: 'fish', heaviness: 'medium' } }), 'medium');
  // десерты не бывают лёгкими (сахар)
  assert.equal(effectiveHeaviness({ tags: ['dessert'] }), 'medium');
  assert.equal(effectiveHeaviness({ tags: ['baking'], attrs: { mainProtein: 'none' } }), 'medium');
});

test('effectiveHeaviness: калории на порцию переопределяют класс', () => {
  const dict = buildDict({
    'лосось': { kcal: 208, protein: 20, fat: 13, carbs: 0 },
    'сливочное масло': { kcal: 717, protein: 0.8, fat: 81, carbs: 0.1 },
  });
  // жирная рыба в масле: 300г лосося + 100г масла на 1 порцию → >550 ккал → сытное
  const fatty = { tags: ['fish'], servings: 1, ingredients: [
    { n: 'Лосось', a: '300 г', qty: 300, unit: 'g', ing: 'лосось' },
    { n: 'Сливочное масло', a: '100 г', qty: 100, unit: 'g', ing: 'сливочное масло' },
  ]};
  assert.equal(effectiveHeaviness(fatty, dict), 'heavy');
  // скромная порция рыбы → лёгкое
  const lean = { tags: ['fish'], servings: 2, ingredients: [
    { n: 'Лосось', a: '300 г', qty: 300, unit: 'g', ing: 'лосось' },
  ]};
  assert.equal(effectiveHeaviness(lean, dict), 'light');
});

test('filterCandidates: приём пищи, время, строгая сытность', () => {
  const dinner = filterCandidates(CATALOG, { meal: 'dinner' });
  assert.deepEqual(dinner.map(r => r.id), ['soup', 'fresh', 'never', 'heavy']);
  // лимит времени: без известного времени — исключаются
  const quick = filterCandidates(CATALOG, { meal: 'dinner', maxMin: 30 });
  assert.deepEqual(quick.map(r => r.id), ['soup', 'fresh']);
  // полегче — строго: только салат; мясное «never» больше не проходит
  const light = filterCandidates(CATALOG, { meal: 'dinner', mood: 'light' });
  assert.deepEqual(light.map(r => r.id), ['fresh']);
  // обычное — суп (без мяса в тегах) и немигрированное мясо
  const normal = filterCandidates(CATALOG, { meal: 'dinner', mood: 'normal' });
  assert.deepEqual(normal.map(r => r.id), ['soup', 'never']);
  // сытное — только heavy
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
  const r1 = pickSuggestion(CATALOG, { meal: 'dinner', mood: 'light' }, ['fresh'], NOW, () => 0);
  assert.equal(r1.recipe.id, 'fresh');
  assert.equal(r1.relaxed, 'repeat');
});

test('pickSuggestion: ослабление времени сохраняет сытность', () => {
  // ничего не влезает в 10 минут → relaxed:time
  const r2 = pickSuggestion(CATALOG, { meal: 'dinner', maxMin: 10 }, [], NOW, () => 0);
  assert.ok(r2.recipe);
  assert.equal(r2.relaxed, 'time');
  // время ослабили, но «полегче» удержали: только салат
  const r3 = pickSuggestion(CATALOG, { meal: 'dinner', maxMin: 10, mood: 'light' }, [], NOW, () => 0);
  assert.equal(r3.recipe.id, 'fresh');
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
