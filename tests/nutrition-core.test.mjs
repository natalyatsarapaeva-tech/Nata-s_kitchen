import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  amountToGrams, nutritionPayload, expandIngredients,
  buildDict, dictLookup, entryKey, gramsForEntry, computeRecipeNutrition,
  DEFAULT_UNIT_G
} from '../js/nutrition-core.js';

const approx = (got, exp, eps = 0.01) =>
  assert.ok(Math.abs(got - exp) < eps, `expected ~${exp}, got ${got}`);

test('amountToGrams: весовые и объёмные единицы', () => {
  approx(amountToGrams('200 г'), 200);
  approx(amountToGrams('1,5 кг'), 1500);
  approx(amountToGrams('100 мл'), 100);
  approx(amountToGrams('1 л'), 1000);
  approx(amountToGrams('⅓ стакана'), 200 / 3);
  approx(amountToGrams('1 1/2 стакана'), 300);
});

test('amountToGrams: ложки с пробелами и юникод-дробями (регрессия)', () => {
  approx(amountToGrams('2 ст. л.'), 30);
  approx(amountToGrams('2 ст.л.'), 30);
  approx(amountToGrams('1 ч. л.'), 5);
  approx(amountToGrams('½ ч. л.'), 2.5);
  approx(amountToGrams('по ½ ч. л.'), 2.5);
});

test('amountToGrams: штучные кулинарные единицы', () => {
  approx(amountToGrams('1 кочан'), 1200);
  approx(amountToGrams('2 зубчика'), 10);
  approx(amountToGrams('1 пучок'), 40);
  approx(amountToGrams('2 стебля'), 40);
});

test('amountToGrams: штуки и размеры через unitG', () => {
  approx(amountToGrams('3 шт', 60), 180);
  approx(amountToGrams('2', 100), 200);          // «2» без единицы + unitG
  approx(amountToGrams('2 крупных', 100), 280);  // размерный множитель 1.4
  assert.equal(amountToGrams('2 крупных', null), null); // размер без unitG — не считаем
  assert.equal(amountToGrams('3 шт', null), null);
});

test('amountToGrams: явный вес в скобках приоритетнее оценок', () => {
  approx(amountToGrams('2 средних (700 г)', 80), 700);
  approx(amountToGrams('1 шт (~250 г)', 60), 250);
});

test('amountToGrams: непарсибельное', () => {
  assert.equal(amountToGrams('по вкусу'), null);
  assert.equal(amountToGrams('щепотка'), null); // без числа
  assert.equal(amountToGrams(''), null);
  assert.equal(amountToGrams(null), null);
});

test('nutritionPayload: валидация ответа GPT', () => {
  assert.deepEqual(nutritionPayload({ kcal: 41, protein: 0.9, fat: 0.2, carbs: 9.6 }),
    { kcal: 41, protein: 0.9, fat: 0.2, carbs: 9.6 });
  assert.deepEqual(nutritionPayload({ kcal: 60, protein: 1, fat: 1, carbs: 1, unitG: 80 }),
    { kcal: 60, protein: 1, fat: 1, carbs: 1, unitG: 80 });
  // отсутствующие макро → 0, а не NaN
  assert.deepEqual(nutritionPayload({ kcal: 10 }), { kcal: 10, protein: 0, fat: 0, carbs: 0 });
  assert.equal(nutritionPayload(null), null);
  assert.equal(nutritionPayload({ protein: 5 }), null); // без kcal — невалидно
  // микроэлементы пишутся, только если модель их вернула
  assert.deepEqual(nutritionPayload({ kcal: 340, protein: 13, fat: 2, carbs: 72, fiber: 11, potassium: 360, phosphorus: 350 }),
    { kcal: 340, protein: 13, fat: 2, carbs: 72, fiber: 11, potassium: 360, phosphorus: 350 });
  assert.equal('fiber' in nutritionPayload({ kcal: 10, protein: 0, fat: 0, carbs: 0 }), false);
});

test('computeRecipeNutrition: клетчатка/калий/фосфор, netCarbs, неполнота', () => {
  const dict = buildDict({
    'цельнозерновая мука': { kcal: 340, protein: 13, fat: 2, carbs: 72, fiber: 11, potassium: 360, phosphorus: 350 },
    'масло': { kcal: 717, protein: 0.9, fat: 81, carbs: 0.1 }, // без микроэлементов
  });
  const recipe = { servings: 2, ingredients: [
    { n: 'Мука ц/з', a: '100 г', qty: 100, unit: 'g', ing: 'цельнозерновая мука' },
    { n: 'Масло', a: '100 г', qty: 100, unit: 'g', ing: 'масло' },
  ]};
  const { totals, perServing, microMissing } = computeRecipeNutrition(recipe, dict);
  assert.equal(Math.round(totals.fiber), 11);       // только из муки
  assert.equal(Math.round(totals.potassium), 360);
  assert.equal(Math.round(totals.carbs), 72);       // 72 + 0.1 ≈ 72
  assert.equal(Math.round(totals.netCarbs), 61);    // 72.1 − 11
  assert.ok(microMissing.fiber, 'у масла нет микроэлементов — сумма неполная');
  assert.equal(Math.round(perServing.netCarbs), 31); // на порцию из 2
  assert.equal(Math.round(perServing.potassium), 180);
});

test('expandIngredients: разделители с вложенным ингредиентом', () => {
  const out = expandIngredients([
    { n: '— РАГУ: Морковь', a: '1 шт' },
    { n: 'Лук', a: '1 шт' },
    { n: '— БЕШАМЕЛЬ', a: '' },
    { n: 'Мука', a: '25 г' },
    { n: '', a: 'мусор' },
  ]);
  assert.deepEqual(out, [
    { divider: 'РАГУ' },
    { n: 'Морковь', a: '1 шт' },
    { n: 'Лук', a: '1 шт' },
    { divider: 'БЕШАМЕЛЬ' },
    { n: 'Мука', a: '25 г' },
  ]);
});

test('expandIngredients: структурированные поля сохраняются', () => {
  const out = expandIngredients([
    { n: '— СОУС: Йогурт', a: '250 мл', qty: 250, unit: 'ml', ing: 'йогурт' },
    { n: 'Мука', a: '2 ст. л.', qty: 2, unit: 'tbsp', ing: 'мука', opt: true },
  ]);
  assert.equal(out[1].qty, 250);
  assert.equal(out[1].unit, 'ml');
  assert.equal(out[1].ing, 'йогурт');
  assert.equal(out[1].n, 'Йогурт');
  assert.equal(out[2].opt, true);
});

test('buildDict + dictLookup: канонические ключи и синонимы', () => {
  const dict = buildDict({
    'помидор': { kcal: 20, protein: 1, fat: 0, carbs: 4, aliases: ['томат', 'помидоры'] },
    'мука': { kcal: 340, protein: 10, fat: 1, carbs: 70 },
  });
  assert.equal(dictLookup(dict, 'помидор').kcal, 20);
  assert.equal(dictLookup(dict, 'томат').kcal, 20);
  assert.equal(dictLookup(dict, 'помидоры').kcal, 20);
  assert.equal(dictLookup(dict, 'мука').kcal, 340);
  assert.equal(dictLookup(dict, 'неизвестное'), null);
  assert.equal(dictLookup(dict, ''), null);
  assert.equal(dictLookup(null, 'мука'), null);
});

test('entryKey: канонический ing приоритетнее нормализованного имени', () => {
  assert.equal(entryKey({ n: 'Помидоры спелые', ing: 'помидор' }), 'помидор');
  assert.equal(entryKey({ n: 'Оливковое масло' }), 'оливковое масло');
  assert.equal(entryKey({}), '');
});

test('gramsForEntry: структурированные qty/unit в приоритете над текстом', () => {
  // structured g: текст противоречит — верим структуре
  approx(gramsForEntry({ n: 'Мука', a: '999 г', qty: 25, unit: 'g' }, null), 25);
  approx(gramsForEntry({ n: 'Молоко', a: '', qty: 500, unit: 'ml' }, null), 500);
  approx(gramsForEntry({ n: 'Масло', a: '', qty: 2, unit: 'tbsp' }, null), 30);
  approx(gramsForEntry({ n: 'Соль', a: '', qty: 1, unit: 'tsp' }, null), 5);
  approx(gramsForEntry({ n: 'Перец', a: '', qty: 1, unit: 'pinch' }, null), 1);
});

test('gramsForEntry: pcs через unitG справочника или дефолты', () => {
  approx(gramsForEntry({ n: 'Яйцо', a: '', qty: 3, unit: 'pcs' }, { unitG: 60 }), 180);
  // без unitG в справочнике — дефолт по каноническому ключу
  approx(gramsForEntry({ n: 'что-то', ing: 'картофель', a: '', qty: 2, unit: 'pcs' }, {}), 2 * DEFAULT_UNIT_G['картофель']);
  // без unitG вообще — null, а не выдумка
  assert.equal(gramsForEntry({ n: 'Экзотика', a: '', qty: 2, unit: 'pcs' }, {}), null);
});

test('gramsForEntry: fallback на свободный текст для немигрированных', () => {
  approx(gramsForEntry({ n: 'Мука', a: '200 г' }, {}), 200);
  approx(gramsForEntry({ n: 'Морковь', a: '2 шт' }, { unitG: 80 }), 160);
  // unitG из DEFAULT_UNIT_G, если в справочнике нет
  approx(gramsForEntry({ n: 'Морковь', a: '2 шт' }, {}), 160);
});

const DICT = buildDict({
  'морковь': { kcal: 41, protein: 0.9, fat: 0.2, carbs: 9.6, unitG: 80 },
  'оливковое масло': { kcal: 884, protein: 0, fat: 100, carbs: 0 },
  'картофель': { kcal: 77, protein: 2, fat: 0.1, carbs: 17, unitG: 150 },
  'соль': { kcal: 0, protein: 0, fat: 0, carbs: 0 },
});

test('computeRecipeNutrition: итоги, на порцию, разделители', () => {
  const recipe = {
    servings: 4,
    ingredients: [
      { n: '— БАЗА: Морковь', a: '2 шт' },
      { n: 'Оливковое масло', a: '2 ст. л.' },
      { n: 'Соль', a: '½ ч. л.' },
      { n: 'Картофель', a: '3 шт' },
      { n: 'Неизвестный ингредиент', a: '100 г' },
    ],
  };
  const r = computeRecipeNutrition(recipe, DICT);
  assert.equal(r.hasData, true);
  assert.equal(r.hasMissing, true);
  assert.equal(r.rows.length, 5);
  assert.equal(r.rows[4].unknown, true);
  // 160г моркови=65.6 + 30г масла=265.2 + 2.5г соли=0 + 450г картофеля=346.5
  approx(r.totals.kcal, 677.3, 0.5);
  assert.equal(r.servings, 4);
  approx(r.perServing.kcal, 677.3 / 4, 0.5);
});

test('computeRecipeNutrition: структурированные поля переопределяют текст', () => {
  const structured = computeRecipeNutrition({
    servings: 2,
    ingredients: [{ n: 'Морковь', a: 'сколько-то', qty: 160, unit: 'g', ing: 'морковь' }],
  }, DICT);
  approx(structured.totals.kcal, 65.6, 0.1);
  approx(structured.perServing.kcal, 32.8, 0.1);
});

test('computeRecipeNutrition: без servings нет perServing', () => {
  const r = computeRecipeNutrition({ ingredients: [{ n: 'Морковь', a: '1 шт' }] }, DICT);
  assert.equal(r.perServing, null);
  assert.equal(r.servings, null);
  assert.equal(r.hasData, true);
});

test('computeRecipeNutrition: пустой рецепт', () => {
  const r = computeRecipeNutrition({ ingredients: [] }, DICT);
  assert.equal(r.hasData, false);
  assert.equal(r.hasMissing, false);
  assert.equal(r.rows.length, 0);
});
