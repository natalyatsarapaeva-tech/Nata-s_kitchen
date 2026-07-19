import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSubMap, substituteEntry, substituteIngredients, recipeWithSubs,
} from '../js/substitute.js';

test('buildSubMap: нормализует ключи, пустые правила отбрасываются', () => {
  const map = buildSubMap([
    { from: 'Мука', to: 'цельнозерновая мука' },
    { from: '  сахар ', to: 'эритрит' },
    { from: '', to: 'x' },      // без from — мимо
    { from: 'рис', to: '' },    // без to — мимо
  ]);
  assert.deepEqual(map, { 'мука': 'цельнозерновая мука', 'сахар': 'эритрит' });
});

test('substituteEntry: замена по каноническому ключу, количество сохраняется', () => {
  const map = buildSubMap([{ from: 'сахар', to: 'эритрит' }]);
  const out = substituteEntry({ n: 'Сахар', a: '100 г', qty: 100, unit: 'g', ing: 'сахар' }, map);
  assert.equal(out.n, 'эритрит');
  assert.equal(out.ing, 'эритрит');
  assert.equal(out.origName, 'Сахар'); // для показа «вместо…»
  assert.equal(out.qty, 100);          // количество не тронуто
  assert.equal(out.unit, 'g');
});

test('substituteEntry: матч по имени, когда нет ing', () => {
  const map = buildSubMap([{ from: 'мука', to: 'цельнозерновая мука' }]);
  const out = substituteEntry({ n: 'Мука', a: '200 г' }, map);
  assert.equal(out.n, 'цельнозерновая мука');
  assert.equal(out.ing, 'цельнозерновая мука');
});

test('substituteEntry: без правила — возвращает как есть', () => {
  const map = buildSubMap([{ from: 'сахар', to: 'эритрит' }]);
  const entry = { n: 'Морковь', a: '2 шт' };
  assert.equal(substituteEntry(entry, map), entry);
});

test('substituteEntry: строка-разделитель — меняется продукт после двоеточия', () => {
  const map = buildSubMap([{ from: 'мука', to: 'цельнозерновая мука' }]);
  const out = substituteEntry({ n: '— ТЕСТО: Мука', a: '300 г' }, map);
  assert.equal(out.n, '— ТЕСТО: цельнозерновая мука');
  assert.equal(out.ing, 'цельнозерновая мука');
  // разделитель без совпадения не трогаем
  assert.equal(substituteEntry({ n: '— НАЧИНКА: Творог' }, map).n, '— НАЧИНКА: Творог');
});

test('substituteIngredients / recipeWithSubs: пустые правила — исходные данные', () => {
  const recipe = { id: 'r', ingredients: [{ n: 'Сахар', a: '50 г' }] };
  assert.equal(recipeWithSubs(recipe, {}), recipe, 'нет правил — тот же объект');
  assert.equal(substituteIngredients(recipe.ingredients, null), recipe.ingredients);

  const map = buildSubMap([{ from: 'сахар', to: 'эритрит' }]);
  const view = recipeWithSubs(recipe, map);
  assert.notEqual(view, recipe, 'копия, оригинал не мутируется');
  assert.equal(recipe.ingredients[0].n, 'Сахар', 'оригинал цел');
  assert.equal(view.ingredients[0].n, 'эритрит');
});
