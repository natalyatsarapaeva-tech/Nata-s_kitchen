import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REGULAR_TAG, isRegularRecipe, regularRecipeId, clampRegularCount,
  buildRegularUserMsg, normalizeParsedRegular, filterForeignRegular,
} from '../js/regular.js';

test('isRegularRecipe: по тэгу', () => {
  assert.equal(isRegularRecipe({ tags: ['veggie', 'regular'] }), true);
  assert.equal(isRegularRecipe({ tags: ['veggie'] }), false);
  assert.equal(isRegularRecipe({}), false);
  assert.equal(isRegularRecipe(null), false);
});

test('regularRecipeId: стабильный, без метки времени', () => {
  assert.equal(regularRecipeId('Гречка с курицей'), 'reg-гречка-с-курицей');
  assert.equal(regularRecipeId('Гречка с курицей'), regularRecipeId('Гречка с курицей'),
    'повторный разбор перезаписывает тот же документ');
  assert.equal(regularRecipeId('Омлет!'), 'reg-омлет');
});

test('clampRegularCount: границы и мусор', () => {
  assert.equal(clampRegularCount('7'), 7);
  assert.equal(clampRegularCount(''), null);
  assert.equal(clampRegularCount('abc'), null);
  assert.equal(clampRegularCount('0'), 1);
  assert.equal(clampRegularCount('99'), 15);
});

test('buildRegularUserMsg: с числом и без', () => {
  const withCount = buildRegularUserMsg('омлет и блины', 6);
  assert.match(withCount, /омлет и блины/);
  assert.match(withCount, /6 рецептов/);
  const noCount = buildRegularUserMsg('омлет и блины');
  assert.match(noCount, /от 5 до 10/);
});

const PARSED = {
  recipes: [
    {
      title: ' Гречка с курицей ', emoji: '🍗', category: 'chicken',
      meta: '~30 мин · 4 порции', yield: '4 порции', servings: '4',
      ingredients: [
        { n: 'Гречка', a: '300 г', qty: 300, unit: 'g', ing: 'Гречка', opt: null },
        { n: 'Куриное филе', a: '500 г', qty: '500', unit: 'g', ing: 'куриное филе' },
        { n: '', a: '' }, // пустая строка — отбрасывается
      ],
      steps: ['Отварить гречку', 'Обжарить курицу', ''],
      attrs: { mealType: ['dinner'], mainProtein: 'chicken', heaviness: 'medium' },
    },
    { title: 'Омлет', emoji: '🍳', category: 'нет такой', servings: 0,
      ingredients: [{ n: 'Яйца', a: '3 шт', qty: 3, unit: 'pcs', ing: 'яйцо' }], steps: ['Взбить и пожарить'] },
    { title: '', ingredients: [{ n: 'Хлеб', a: '1 шт' }] }, // без названия — мимо
    { title: 'Пустое блюдо', ingredients: [] },             // без ингредиентов — мимо
  ],
};

test('normalizeParsedRegular: тэг regular всегда, категория — только из известных', () => {
  const out = normalizeParsedRegular(PARSED, 'default');
  assert.equal(out.length, 2);

  const [grechka, omelet] = out;
  assert.equal(grechka.id, 'reg-гречка-с-курицей');
  assert.equal(grechka.title, 'Гречка с курицей');
  assert.deepEqual(grechka.tags, ['chicken', REGULAR_TAG]);
  assert.equal(grechka.servings, 4);
  assert.equal(grechka.source, 'regular');
  assert.equal(grechka.createdBy, 'default');
  assert.equal(grechka.attrs.mainProtein, 'chicken');
  // строки чистятся как при импорте: qty приводится к числу, пустые уходят
  assert.equal(grechka.ingredients.length, 2);
  assert.equal(grechka.ingredients[1].qty, 500);
  assert.equal(grechka.ingredients[0].ing, 'гречка');
  assert.deepEqual(grechka.steps, ['Отварить гречку', 'Обжарить курицу']);

  assert.deepEqual(omelet.tags, [REGULAR_TAG], 'неизвестная категория отбрасывается');
  assert.equal(omelet.servings, undefined, 'servings 0 не пишется');
});

test('normalizeParsedRegular: мусорный ответ — пустой список', () => {
  assert.deepEqual(normalizeParsedRegular(null), []);
  assert.deepEqual(normalizeParsedRegular({}), []);
  assert.deepEqual(normalizeParsedRegular({ recipes: 'не массив' }), []);
});

test('regularRecipeId: пер-семейный, легаси-формат для default', () => {
  assert.equal(regularRecipeId('Омлет', null), 'reg-омлет');
  assert.equal(regularRecipeId('Омлет', 'default'), 'reg-омлет');
  assert.equal(regularRecipeId('Омлет', 'sestra-x1'), 'reg-sestra-x1-омлет');
  assert.equal(regularRecipeId('!!!', 'sestra-x1'), '', 'пустой слаг — пустой id');
});

test('normalizeParsedRegular: householdId пишется на рецепт и входит в id', () => {
  const out = normalizeParsedRegular(PARSED, 'uid1', 'sestra-x1');
  assert.equal(out[0].householdId, 'sestra-x1');
  assert.equal(out[0].id, 'reg-sestra-x1-гречка-с-курицей');
  assert.equal(out[0].createdBy, 'uid1');
  // без семьи (легаси/тесты) — прежний формат
  const legacy = normalizeParsedRegular(PARSED, 'default');
  assert.equal(legacy[0].id, 'reg-гречка-с-курицей');
  assert.equal(legacy[0].householdId, undefined);
});

test('filterForeignRegular: чужие регулярные скрыты, базовые и свои — видны', () => {
  const recipes = [
    { id: 'base', tags: ['soup'] },
    { id: 'my-reg', tags: ['regular'], householdId: 'sestra-x1' },
    { id: 'their-reg', tags: ['regular'], householdId: 'mama-x2' },
    { id: 'legacy-reg', tags: ['regular'] }, // без поля — семьи default
  ];
  assert.deepEqual(filterForeignRegular(recipes, 'sestra-x1').map(r => r.id),
    ['base', 'my-reg']);
  assert.deepEqual(filterForeignRegular(recipes, 'default').map(r => r.id),
    ['base', 'legacy-reg']);
  assert.deepEqual(filterForeignRegular(recipes, null).map(r => r.id),
    ['base', 'legacy-reg'], 'без семьи — как легаси');
});
