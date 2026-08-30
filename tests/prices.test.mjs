import test from 'node:test';
import assert from 'node:assert/strict';
import {
  packWeightG, unitPricesFromLine, normalizeReceipt, priceStats, addPriceSample,
  priceVerdict, estimateItemCost, basketTotal, parsePriceInput, priceKeyFor,
  percentile, PRICE_TTL_DAYS, MAX_SAMPLES,
} from '../js/prices.js';

const NOW = Date.parse('2026-08-30');
const daysAgo = n => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

test('packWeightG: вес упаковки из названия товара', () => {
  assert.equal(packWeightG('Молоко Простокваш.3,2% 930мл'), 930);
  assert.equal(packWeightG('Сыр Российский 45% 200 г'), 200);
  assert.equal(packWeightG('Мука пшеничная 2 кг'), 2000);
  assert.equal(packWeightG('Масло подсолн. 1 л'), 1000);
  assert.equal(packWeightG('Яйцо С0 10шт'), null, 'штуки — не вес');
  assert.equal(packWeightG('Курица охлаждённая'), null);
});

test('unitPricesFromLine: цена за кг и за штуку из строки чека', () => {
  // весовой товар
  assert.deepEqual(unitPricesFromLine({ name: 'Кур.филе охл.', qty: 0.86, unit: 'кг', sum: 361.2 }),
    { perKg: 420, perPcs: null });
  // граммы
  assert.deepEqual(unitPricesFromLine({ name: 'Сыр', qty: 200, unit: 'г', sum: 180 }),
    { perKg: 900, perPcs: null });
  // штучный без веса в названии — только цена за штуку
  assert.deepEqual(unitPricesFromLine({ name: 'Хлеб Бородинский', qty: 2, unit: 'шт', sum: 118 }),
    { perKg: null, perPcs: 59 });
  // штучный с весом упаковки — считаем и за кг
  assert.deepEqual(unitPricesFromLine({ name: 'Молоко 930мл', qty: 1, unit: 'шт', sum: 93 }),
    { perKg: 100, perPcs: 93 });
  // без суммы строка бесполезна
  assert.deepEqual(unitPricesFromLine({ name: 'Пакет', qty: 1, unit: 'шт' }),
    { perKg: null, perPcs: null });
});

test('normalizeReceipt: мусорные строки выбрасываются, ключ канонический', () => {
  const r = normalizeReceipt({
    store: 'Пятёрочка', date: '2026-08-29',
    lines: [
      { name: 'Кур.филе охл.подл.', product: 'куриное филе', qty: 0.86, unit: 'кг', sum: 361.2 },
      { name: 'Молоко тёплое 930мл', product: 'молоко тёплое', qty: 1, unit: 'шт', sum: 93 },
      { name: 'Пакет майка', product: 'пакет', qty: 1, unit: 'шт' },   // без суммы
      { name: '', product: '', qty: 1, unit: 'шт', sum: 50 },          // без названия
      { name: 'Скидка по карте', product: 'скидка', qty: 1, unit: 'шт', sum: 0 },
    ],
  });
  assert.equal(r.store, 'Пятёрочка');
  assert.equal(r.date, '2026-08-29');
  assert.equal(r.lines.length, 2, 'пакет, пустая строка и скидка отброшены');
  assert.equal(r.lines[0].key, 'куриное филе');
  assert.equal(r.lines[0].perKg, 420);
  // модификатор «тёплое» срезается канонизацией — цена цепляется к «молоко»
  assert.equal(r.lines[1].key, 'молоко');
  assert.equal(r.lines[1].perPcs, 93);
  // битый ответ модели не роняет разбор
  assert.deepEqual(normalizeReceipt(null).lines, []);
  assert.deepEqual(normalizeReceipt({ lines: 'нет' }).lines, []);
});

test('priceKeyFor: тот же ключ, что в списке покупок', () => {
  assert.equal(priceKeyFor('Молоко тёплое'), 'молоко');
  assert.equal(priceKeyFor('Яйца куриные'), 'яйцо');
  assert.equal(priceKeyFor('Куриное филе'), 'куриное филе');
});

test('percentile и priceStats: медиана, p25, протухшие наблюдения', () => {
  assert.equal(percentile([100], 0.5), 100);
  assert.equal(percentile([100, 200, 300], 0.5), 200);
  assert.equal(percentile([100, 200, 300, 400], 0.25), 175);

  const doc = { samples: [
    { date: daysAgo(3), perKg: 400 },
    { date: daysAgo(20), perKg: 500 },
    { date: daysAgo(40), perKg: 450 },
    { date: daysAgo(PRICE_TTL_DAYS + 10), perKg: 120 }, // прошлогодняя — не в счёт
  ]};
  const st = priceStats(doc, NOW);
  assert.equal(st.perKg.count, 3, 'протухшее наблюдение отброшено');
  assert.equal(st.perKg.median, 450);
  assert.equal(st.perKg.min, 400);
  assert.equal(st.perKg.last, 400, 'last — самое свежее наблюдение');
  assert.equal(st.lastDate, daysAgo(3));
  assert.equal(priceStats({ samples: [] }, NOW), null);
  assert.equal(priceStats(null, NOW), null);
});

test('addPriceSample: свежее вперёд, дубль дня перезаписывается, лимит хранения', () => {
  let doc = { samples: [{ date: daysAgo(10), perKg: 500, source: 'receipt' }] };
  doc = addPriceSample(doc, { date: daysAgo(1), perKg: 420, store: 'Лента', source: 'receipt' }, NOW);
  assert.equal(doc.samples[0].perKg, 420, 'свежее наблюдение первое');
  assert.equal(doc.samples.length, 2);
  // тот же день и магазин — пересняли чек, а не удвоили вес
  doc = addPriceSample(doc, { date: daysAgo(1), perKg: 430, store: 'Лента', source: 'receipt' }, NOW);
  assert.equal(doc.samples.length, 2);
  assert.equal(doc.samples[0].perKg, 430);
  // наблюдение без цены игнорируется
  assert.equal(addPriceSample(doc, { date: daysAgo(1) }, NOW).samples.length, 2);
  // лимит хранения
  let big = { samples: [] };
  for (let i = 0; i < MAX_SAMPLES + 10; i++) {
    big = addPriceSample(big, { date: daysAgo(i), perKg: 100 + i, store: 'м' + i }, NOW);
  }
  assert.equal(big.samples.length, MAX_SAMPLES);
  assert.equal(big.samples[0].perKg, 100, 'остались самые свежие');
});

test('priceVerdict: хорошая цена — не дороже нижней четверти своих наблюдений', () => {
  const st = priceStats({ samples: [
    { date: daysAgo(1), perKg: 400 }, { date: daysAgo(5), perKg: 450 },
    { date: daysAgo(9), perKg: 500 }, { date: daysAgo(14), perKg: 600 },
  ]}, NOW).perKg;
  assert.equal(st.median, 475);
  assert.equal(priceVerdict(430, st), 'good', 'p25 = 437.5');
  assert.equal(priceVerdict(460, st), 'ok');
  assert.equal(priceVerdict(600, st), 'high');
  // мало наблюдений — молчим, а не гадаем
  const few = priceStats({ samples: [{ date: daysAgo(1), perKg: 400 }, { date: daysAgo(2), perKg: 500 }] }, NOW).perKg;
  assert.equal(priceVerdict(400, few), null);
  assert.equal(priceVerdict(null, st), null);
});

test('estimateItemCost: весовой по цене за кг, штучный по цене за штуку', () => {
  const kgDoc = { samples: [
    { date: daysAgo(1), perKg: 400 }, { date: daysAgo(5), perKg: 500 }, { date: daysAgo(9), perKg: 450 }] };
  const est = estimateItemCost({ key: 'куриное филе', grams: 750, pcs: 0, unitG: null }, kgDoc, NOW);
  assert.equal(est.per, 'kg');
  assert.equal(Math.round(est.cost), 338); // 0.75 кг × медиана 450

  // штучный товар: количество округляется вверх так же, как в подписи списка
  const pcsDoc = { samples: [{ date: daysAgo(1), perPcs: 12 }, { date: daysAgo(3), perPcs: 10 }] };
  const eggs = estimateItemCost({ key: 'яйцо', pcs: 2, grams: 750, unitG: 60 }, pcsDoc, NOW);
  assert.equal(eggs.per, 'pcs');
  assert.equal(eggs.cost, 15 * 11); // ceil(2 + 750/60) = 15 штук × медиана 11

  // цена только за кг, а товар штучный — считаем по весу, а не молчим
  const potato = estimateItemCost({ key: 'картофель', pcs: 5, grams: 0, unitG: 150 },
    { samples: [{ date: daysAgo(1), perKg: 60 }] }, NOW);
  assert.equal(potato.per, 'kg');
  assert.equal(Math.round(potato.cost), 45); // 750 г × 60 ₽/кг

  assert.equal(estimateItemCost({ key: 'соль', grams: 100 }, null, NOW), null, 'нет цены — нет оценки');
  assert.equal(estimateItemCost({ key: 'соль', grams: 0, pcs: 0 },
    { samples: [{ date: daysAgo(1), perKg: 20 }] }, NOW), null, 'нет количества — нет оценки');
});

test('basketTotal: сумма и честное покрытие', () => {
  const items = [
    { key: 'куриное филе', grams: 1000, pcs: 0, unitG: null },
    { key: 'молоко', grams: 600, pcs: 0, unitG: null },
    { key: 'укроп', grams: 0, pcs: 0, unitG: null, lines: ['по вкусу'] },
  ];
  const prices = {
    'куриное филе': { samples: [{ date: daysAgo(2), perKg: 400 }] },
    'молоко': { samples: [{ date: daysAgo(2), perKg: 100 }] },
  };
  const t = basketTotal(items, prices, NOW);
  assert.equal(Math.round(t.sum), 460);
  assert.equal(t.covered, 2);
  assert.equal(t.total, 3);
  assert.deepEqual(basketTotal([], {}, NOW), { sum: 0, covered: 0, total: 0 });
});

test('parsePriceInput: ручной ввод цены', () => {
  assert.deepEqual(parsePriceInput('450'), { perKg: 450 });
  assert.deepEqual(parsePriceInput('450 ₽/кг'), { perKg: 450 });
  assert.deepEqual(parsePriceInput('89,90 за шт'), { perPcs: 89.9 });
  assert.deepEqual(parsePriceInput('120 руб/упаковка'), { perPcs: 120 });
  assert.deepEqual(parsePriceInput('12', 'pcs'), { perPcs: 12 });
  assert.equal(parsePriceInput(''), null);
  assert.equal(parsePriceInput('дорого'), null);
  assert.equal(parsePriceInput('0'), null);
});
