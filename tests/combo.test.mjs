import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySide, classifyProtein, pairAllowed, pairReason,
  generateCombos, comboTitle, comboToRecipe, buildComboRecipes,
  normalizeParsedCombo, buildComboUserMsg,
  SIDE_CATEGORIES, PROTEIN_CATEGORIES,
} from '../js/combo.js';
import { REGULAR_TAG, isRegularRecipe } from '../js/regular.js';

test('classifySide: крахмалистые и овощные гарниры', () => {
  assert.equal(classifySide('Макароны'), 'pasta');
  assert.equal(classifySide('Спагетти'), 'pasta');
  assert.equal(classifySide('Картофельное пюре'), 'potato');
  assert.equal(classifySide('Отварной картофель'), 'potato');
  assert.equal(classifySide('Гречневая крупа'), 'grain');
  assert.equal(classifySide('Перловка'), 'grain');
  assert.equal(classifySide('Овсяная крупа'), 'grain');
  assert.equal(classifySide('Киноа'), 'grain');
  assert.equal(classifySide('Отварной рис'), 'grain');
  assert.equal(classifySide('Тушёная капуста'), 'vegetable');
  assert.equal(classifySide('Овощное рагу'), 'vegetable');
  assert.equal(classifySide('Что-то неведомое'), null);
});

test('classifyProtein: классы белка, рыба раньше мяса', () => {
  assert.equal(classifyProtein('Куриные наггетсы'), 'chicken');
  assert.equal(classifyProtein('Куриные тефтели'), 'chicken');
  assert.equal(classifyProtein('Стейк из рыбы'), 'fish', 'рыба важнее «стейк»');
  assert.equal(classifyProtein('Лосось на пару'), 'fish');
  assert.equal(classifyProtein('Креветки'), 'seafood');
  assert.equal(classifyProtein('Говяжьи котлеты'), 'meat');
  assert.equal(classifyProtein('Рагу из мяса'), 'meat');
  assert.equal(classifyProtein('Рагу из фасоли'), 'legumes');
  assert.equal(classifyProtein('Чечевица'), 'legumes');
  assert.equal(classifyProtein('Омлет'), 'egg');
});

test('pairAllowed: рыба не с пастой, бобовым — не крахмал', () => {
  assert.equal(pairAllowed('fish', 'pasta'), false);
  assert.equal(pairAllowed('seafood', 'pasta'), false);
  assert.equal(pairAllowed('fish', 'potato'), true);
  assert.equal(pairAllowed('fish', 'grain'), true);
  assert.equal(pairAllowed('legumes', 'grain'), false);
  assert.equal(pairAllowed('legumes', 'pasta'), false);
  assert.equal(pairAllowed('legumes', 'potato'), false);
  assert.equal(pairAllowed('legumes', 'vegetable'), true);
  assert.equal(pairAllowed('chicken', 'pasta'), true);
  assert.equal(pairAllowed('meat', 'potato'), true);
  // неизвестная категория (null) не ограничивается
  assert.equal(pairAllowed(null, 'pasta'), true);
});

test('pairReason: объяснения запрета', () => {
  assert.match(pairReason('fish', 'pasta'), /паст/);
  assert.match(pairReason('legumes', 'grain'), /овощ/);
  assert.equal(pairReason('chicken', 'grain'), null);
});

test('generateCombos: только допустимые пары', () => {
  const proteins = [
    { title: 'Рыбный стейк', category: 'fish' },
    { title: 'Рагу из фасоли', category: 'legumes' },
    { title: 'Курица', category: 'chicken' },
  ];
  const sides = [
    { title: 'Макароны', category: 'pasta' },
    { title: 'Гречка', category: 'grain' },
    { title: 'Тушёная капуста', category: 'vegetable' },
  ];
  const combos = generateCombos(proteins, sides);
  const pairs = combos.map(c => [c.protein.title, c.side.title]);
  // рыба+макароны и все бобовые+крахмал исключены
  assert.ok(!pairs.some(([p, s]) => p === 'Рыбный стейк' && s === 'Макароны'));
  assert.ok(!pairs.some(([p]) => p === 'Рагу из фасоли' &&
    combos.find(c => c.protein.title === p).side.category !== 'vegetable'));
  // допустимых пар: fish×{grain,veg}=2 + legumes×{veg}=1 + chicken×3 = 6
  assert.equal(combos.length, 6);
});

test('generateCombos: категория выводится из названия, если не задана', () => {
  const combos = generateCombos(
    [{ title: 'Стейк из лосося' }],
    [{ title: 'Макароны' }, { title: 'Картофельное пюре' }],
  );
  // лосось → fish, макароны запрещены → остаётся только картошка
  assert.equal(combos.length, 1);
  assert.equal(combos[0].side.title, 'Картофельное пюре');
});

test('generateCombos: чередует белок и гарнир, без повторов подряд', () => {
  const proteins = [
    { title: 'Курица', category: 'chicken' },
    { title: 'Котлеты', category: 'meat' },
  ];
  const sides = [
    { title: 'Гречка', category: 'grain' },
    { title: 'Картошка', category: 'potato' },
  ];
  const combos = generateCombos(proteins, sides);
  assert.equal(combos.length, 4, 'все 2×2 допустимы');
  // белок не повторяется подряд (в матрице 2×2 избежать повтора по ОБЕИМ осям
  // одновременно нельзя — гарантируем чередование хотя бы белка)
  for (let i = 1; i < combos.length; i++) {
    assert.notEqual(combos[i].protein.title, combos[i - 1].protein.title,
      'белок не повторяется подряд');
  }
  // все четыре пары различны, каждый белок и гарнир использованы дважды
  const keys = new Set(combos.map(c => c.protein.title + '|' + c.side.title));
  assert.equal(keys.size, 4);
  const countBy = (arr, k) => arr.reduce((m, c) => (m[c[k].title] = (m[c[k].title] || 0) + 1, m), {});
  assert.deepEqual(countBy(combos, 'protein'), { 'Курица': 2, 'Котлеты': 2 });
  assert.deepEqual(countBy(combos, 'side'), { 'Гречка': 2, 'Картошка': 2 });
});

test('generateCombos: max ограничивает количество', () => {
  const proteins = [{ title: 'Курица', category: 'chicken' }, { title: 'Котлеты', category: 'meat' }];
  const sides = [{ title: 'Гречка', category: 'grain' }, { title: 'Рис', category: 'grain' }, { title: 'Картошка', category: 'potato' }];
  assert.equal(generateCombos(proteins, sides, { max: 3 }).length, 3);
  assert.equal(generateCombos(proteins, sides).length, 6);
});

test('generateCombos: детерминированный порядок', () => {
  const proteins = [{ title: 'Курица', category: 'chicken' }, { title: 'Рыба', category: 'fish' }];
  const sides = [{ title: 'Гречка', category: 'grain' }, { title: 'Капуста', category: 'vegetable' }];
  const a = generateCombos(proteins, sides).map(c => comboTitle(c.protein, c.side));
  const b = generateCombos(proteins, sides).map(c => comboTitle(c.protein, c.side));
  assert.deepEqual(a, b);
});

test('generateCombos: пусто, если все пары запрещены', () => {
  const combos = generateCombos(
    [{ title: 'Рыба', category: 'fish' }],
    [{ title: 'Макароны', category: 'pasta' }],
  );
  assert.deepEqual(combos, []);
});

test('comboToRecipe: регулярный рецепт с объединёнными ингредиентами', () => {
  const combo = {
    protein: {
      title: 'Куриные наггетсы', category: 'chicken', emoji: '🍗', servings: 4,
      ingredients: [{ n: 'Куриное филе', a: '500 г', qty: 500, unit: 'g', ing: 'куриное филе' }],
    },
    side: {
      title: 'Гречка', category: 'grain',
      ingredients: [{ n: 'Гречка', a: '250 г', qty: 250, unit: 'g', ing: 'гречка' }],
    },
  };
  const r = comboToRecipe(combo, 'sestra-x1', 'uid1');
  assert.equal(r.title, 'Куриные наггетсы + Гречка');
  assert.equal(r.id, 'reg-sestra-x1-куриные-наггетсы-гречка');
  assert.ok(isRegularRecipe(r), 'тэг regular есть');
  assert.deepEqual(r.tags, ['chicken', REGULAR_TAG]);
  assert.equal(r.ingredients.length, 2);
  assert.equal(r.attrs.mainProtein, 'chicken');
  assert.deepEqual(r.attrs.mealType, ['lunch', 'dinner']);
  assert.equal(r.servings, 4);
  assert.equal(r.source, 'combo');
  assert.equal(r.createdBy, 'uid1');
  assert.equal(r.householdId, 'sestra-x1');
  assert.equal(r.combo.proteinCategory, 'chicken');
  assert.equal(r.combo.sideCategory, 'grain');
});

test('comboToRecipe: легаси-семья (без householdId) — прежний формат id', () => {
  const r = comboToRecipe({
    protein: { title: 'Курица', category: 'chicken', ingredients: [{ n: 'Курица', a: '1' }] },
    side: { title: 'Рис', category: 'grain', ingredients: [{ n: 'Рис', a: '1' }] },
  });
  assert.equal(r.id, 'reg-курица-рис');
  assert.equal(r.householdId, undefined);
  assert.equal(r.createdBy, undefined);
});

test('buildComboRecipes: материализует набор регулярных рецептов', () => {
  const proteins = [
    { title: 'Курица', category: 'chicken', ingredients: [{ n: 'Курица', a: '500 г' }] },
    { title: 'Рыба', category: 'fish', ingredients: [{ n: 'Треска', a: '400 г' }] },
  ];
  const sides = [
    { title: 'Макароны', category: 'pasta', ingredients: [{ n: 'Макароны', a: '300 г' }] },
    { title: 'Капуста', category: 'vegetable', ingredients: [{ n: 'Капуста', a: '400 г' }] },
  ];
  const recipes = buildComboRecipes(proteins, sides, { householdId: 'h1', owner: 'u1' });
  // рыба+макароны исключена → 3 рецепта
  assert.equal(recipes.length, 3);
  assert.ok(recipes.every(isRegularRecipe));
  assert.ok(recipes.every(r => r.householdId === 'h1'));
  assert.ok(!recipes.some(r => r.title === 'Рыба + Макароны'));
  // все id уникальны
  assert.equal(new Set(recipes.map(r => r.id)).size, recipes.length);
});

test('buildComboRecipes: пустые входы — пустой список', () => {
  assert.deepEqual(buildComboRecipes([], []), []);
  assert.deepEqual(buildComboRecipes(null, null), []);
});

test('normalizeParsedCombo: валидные компоненты, категория чинится по названию', () => {
  const parsed = {
    sides: [
      { title: ' Гречка ', category: 'grain', ingredients: [{ n: 'Гречка', a: '250 г', qty: 250, unit: 'g' }] },
      { title: 'Тушёная капуста', category: 'нет такой', ingredients: [{ n: 'Капуста', a: '400 г' }] },
      { title: 'Без ингредиентов', category: 'grain', ingredients: [] }, // отбрасывается
      { title: '', ingredients: [{ n: 'x', a: '1' }] }, // без названия — мимо
    ],
    proteins: [
      { title: 'Наггетсы', category: 'chicken', servings: '4', ingredients: [{ n: 'Курица', a: '500 г' }] },
    ],
  };
  const out = normalizeParsedCombo(parsed);
  assert.equal(out.sides.length, 2);
  assert.equal(out.sides[0].title, 'Гречка');
  assert.equal(out.sides[1].category, 'vegetable', 'неизвестная категория выведена из названия');
  assert.equal(out.proteins.length, 1);
  assert.equal(out.proteins[0].servings, 4);
});

test('normalizeParsedCombo: мусор — пустые списки', () => {
  assert.deepEqual(normalizeParsedCombo(null), { sides: [], proteins: [] });
  assert.deepEqual(normalizeParsedCombo({ sides: 'нет', proteins: 5 }), { sides: [], proteins: [] });
});

test('buildComboUserMsg и таксономия', () => {
  assert.match(buildComboUserMsg('на гарнир гречка, белок курица'), /гречка/);
  assert.deepEqual(SIDE_CATEGORIES, ['pasta', 'potato', 'grain', 'vegetable']);
  assert.ok(PROTEIN_CATEGORIES.includes('legumes'));
});

test('end-to-end: описание → нормализация → комбо-рецепты', () => {
  const parsed = {
    sides: [
      { title: 'Макароны', category: 'pasta', ingredients: [{ n: 'Макароны', a: '300 г' }] },
      { title: 'Гречка', category: 'grain', ingredients: [{ n: 'Гречка', a: '250 г' }] },
      { title: 'Тушёная капуста', category: 'vegetable', ingredients: [{ n: 'Капуста', a: '400 г' }] },
    ],
    proteins: [
      { title: 'Наггетсы', category: 'chicken', ingredients: [{ n: 'Курица', a: '500 г' }] },
      { title: 'Стейк из рыбы', category: 'fish', ingredients: [{ n: 'Лосось', a: '400 г' }] },
      { title: 'Рагу из фасоли', category: 'legumes', ingredients: [{ n: 'Фасоль', a: '300 г' }] },
    ],
  };
  const { sides, proteins } = normalizeParsedCombo(parsed);
  const recipes = buildComboRecipes(proteins, sides, { householdId: 'h1', owner: 'u1' });
  const titles = recipes.map(r => r.title);
  // запреты соблюдены
  assert.ok(!titles.includes('Стейк из рыбы + Макароны'));
  assert.ok(!titles.includes('Рагу из фасоли + Макароны'));
  assert.ok(!titles.includes('Рагу из фасоли + Гречка'));
  // бобовые только с овощами
  assert.ok(titles.includes('Рагу из фасоли + Тушёная капуста'));
  // допустимых: chicken×3 + fish×2 (grain,veg) + legumes×1 = 6
  assert.equal(recipes.length, 6);
});
