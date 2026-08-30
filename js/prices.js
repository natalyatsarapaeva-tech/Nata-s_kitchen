// Цены на продукты: ориентир «хорошей цены» и стоимость недельной корзины.
// Чистая логика без Firebase — тестируется в Node (Firestore-доступ в store.js).
//
// ГДЕ ЖИВУТ ЦЕНЫ. В households/{hid}/prices/{ключ}, а НЕ в общем справочнике
// nutrition/{ключ}: там факты, одинаковые для всех семей (ккал, вес штуки), а
// цена зависит от города, магазина и месяца — у сестры в другом городе наша
// цена на курицу просто врёт. Ключ — тот же канонический ключ, что у списка
// покупок, поэтому цена цепляется к позиции без отдельного сопоставления.
//
// ОТКУДА БЕРУТСЯ. Наблюдение (sample) — одна встреча продукта с ценой: строка
// распознанного чека или ручной ввод. Ориентир считаем ТОЛЬКО по своим
// наблюдениям: никаких средних по стране, которые всё равно не совпадут с
// ближайшим магазином.
import { canonicalShoppingKey } from './planner.js';
import { normalizeIngName, parseLeadingNumber } from './utils.js';

// Наблюдения старше полугода не участвуют в ориентире: инфляция делает
// прошлогоднюю «хорошую цену» вредным советом. Храним не больше MAX_SAMPLES
// последних — документ семьи не должен пухнуть от еженедельных чеков.
export const PRICE_TTL_DAYS = 180;
export const MAX_SAMPLES = 24;

const DAY_MS = 24 * 60 * 60 * 1000;

function toTime(date) {
  const t = Date.parse(date);
  return isNaN(t) ? null : t;
}

export function isFreshSample(s, now = Date.now()) {
  const t = toTime(s?.date);
  return t != null && now - t <= PRICE_TTL_DAYS * DAY_MS;
}

// ── Статистика по наблюдениям ──
// Медиана — ориентир «обычно столько», p25 — граница «хорошая цена». Берём
// перцентиль, а не среднее: одна акция или один дорогой магазин не должны
// сдвигать ориентир для всех остальных походов.
export function percentile(values, p) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  if (v.length === 1) return v[0];
  const idx = (v.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (idx - lo);
}

function statsFor(samples, field) {
  const values = samples.map(s => s?.[field]).filter(v => typeof v === 'number' && v > 0);
  if (!values.length) return null;
  return {
    count: values.length,
    median: percentile(values, 0.5),
    p25: percentile(values, 0.25),
    min: Math.min(...values),
    max: Math.max(...values),
    last: values[0], // samples отсортированы свежими вперёд
  };
}

// Сводка по документу цен: {perKg, perPcs} — каждая часть либо null, либо
// {count, median, p25, min, max, last}. Протухшие наблюдения отброшены.
export function priceStats(doc, now = Date.now()) {
  const samples = (doc?.samples || [])
    .filter(s => isFreshSample(s, now))
    .sort((a, b) => (toTime(b.date) || 0) - (toTime(a.date) || 0));
  if (!samples.length) return null;
  const perKg = statsFor(samples, 'perKg');
  const perPcs = statsFor(samples, 'perPcs');
  if (!perKg && !perPcs) return null;
  return { perKg, perPcs, count: samples.length, lastDate: samples[0].date };
}

// Добавляет наблюдение в документ цен (чистая функция — сохраняет вызывающий).
// Дубли одного дня и магазина перезаписываются: пересняли чек — не удвоили вес.
export function addPriceSample(doc, sample, now = Date.now()) {
  const clean = normalizeSample(sample);
  if (!clean) return doc || { samples: [] };
  const rest = (doc?.samples || []).filter(s =>
    !(s.date === clean.date && (s.store || '') === (clean.store || '')));
  const samples = [clean, ...rest]
    .filter(s => isFreshSample(s, now))
    .sort((a, b) => (toTime(b.date) || 0) - (toTime(a.date) || 0))
    .slice(0, MAX_SAMPLES);
  return { ...(doc || {}), samples, updatedAt: new Date(now).toISOString() };
}

const num = v => (v != null && v !== '' && !isNaN(+v) && +v > 0 ? +v : null);

export function normalizeSample(s) {
  const perKg = num(s?.perKg), perPcs = num(s?.perPcs);
  if (!perKg && !perPcs) return null;
  const out = { date: s?.date || todayISO(), source: s?.source === 'receipt' ? 'receipt' : 'manual' };
  if (perKg) out.perKg = Math.round(perKg * 100) / 100;
  if (perPcs) out.perPcs = Math.round(perPcs * 100) / 100;
  if (s?.store) out.store = String(s.store).slice(0, 40);
  return out;
}

export function todayISO(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── «Хорошая цена» ──
// good — не дороже p25 своих же наблюдений (нижняя четверть того, что мы
// реально видели); high — заметно дороже медианы. Пока наблюдений меньше
// трёх, вердикта нет: по двум точкам «дорого/дёшево» — гадание.
export const MIN_SAMPLES_FOR_VERDICT = 3;
const HIGH_RATIO = 1.15;

export function priceVerdict(price, stat) {
  const p = num(price);
  if (!p || !stat || stat.count < MIN_SAMPLES_FOR_VERDICT) return null;
  if (p <= stat.p25) return 'good';
  if (p >= stat.median * HIGH_RATIO) return 'high';
  return 'ok';
}

export const VERDICT_LABELS = { good: '👍 хорошая цена', ok: 'обычная цена', high: '📈 дороже обычного' };

// ── Стоимость позиции и корзины ──
// Позиция списка покупок приходит из aggregateShopping: {pcs, grams, unitG}.
// Считаем в тех же единицах, в которых показываем количество, иначе сумма
// разойдётся с подписью: штучный товар (есть unitG) — по цене за штуку,
// весовой — по цене за кг.
export function itemQuantity(item) {
  const pcs = item?.pcs || 0, grams = item?.grams || 0, unitG = item?.unitG || null;
  if (unitG) {
    const totalPcs = Math.ceil(pcs + grams / unitG);
    return { pcs: totalPcs, grams: totalPcs * unitG, unitG };
  }
  return { pcs, grams, unitG: null };
}

// Оценка стоимости позиции: {cost, unitPrice, per} либо null, если цены нет
// или количество не в тех единицах (например, только «по вкусу» строками).
export function estimateItemCost(item, doc, now = Date.now()) {
  const stats = priceStats(doc, now);
  if (!stats) return null;
  const q = itemQuantity(item);
  const perPcs = stats.perPcs?.median, perKg = stats.perKg?.median;
  if (q.unitG && perPcs && q.pcs) return { cost: q.pcs * perPcs, unitPrice: perPcs, per: 'pcs' };
  if (perKg && q.grams) return { cost: (q.grams / 1000) * perKg, unitPrice: perKg, per: 'kg' };
  if (perPcs && q.pcs) return { cost: q.pcs * perPcs, unitPrice: perPcs, per: 'pcs' };
  return null;
}

// Стоимость недельной корзины. covered/total — честный индикатор покрытия:
// сумма по половине списка не должна выглядеть как полная (так же, как ккал
// недели в weekTotals показывают, по скольким блюдам они посчитаны).
export function basketTotal(items, pricesByKey, now = Date.now()) {
  let sum = 0, covered = 0;
  for (const it of items || []) {
    const est = estimateItemCost(it, pricesByKey?.[it.key], now);
    if (!est) continue;
    sum += est.cost;
    covered++;
  }
  return { sum, covered, total: (items || []).length };
}

export function formatMoney(v) {
  if (v == null) return '';
  return v >= 1000 ? `${Math.round(v).toLocaleString('ru-RU')} ₽` : `${Math.round(v)} ₽`;
}

// ── Разбор чека ──
// Вес упаковки из названия товара: в чеке «Молоко Простокваш. 3,2% 930мл» —
// цена за штуку известна, а за килограмм считается только отсюда. Мл считаем
// граммами, как и весь остальной проект (nutrition-core).
const PACK_UNITS = { 'г': 1, 'гр': 1, 'g': 1, 'мл': 1, 'ml': 1, 'кг': 1000, 'kg': 1000, 'л': 1000, 'l': 1000 };

export function packWeightG(name) {
  const t = String(name || '').toLowerCase().replace(',', '.');
  const re = /(\d+(?:\.\d+)?)\s*(кг|kg|гр|г|g|мл|ml|л|l)(?![а-яёa-z])/g;
  let best = null, m;
  while ((m = re.exec(t))) {
    const g = parseFloat(m[1]) * PACK_UNITS[m[2]];
    // «3.2%» не единица, а жирность — её regex и не поймает; из нескольких
    // чисел берём наибольшее: «Сыр 45% 200 г» → 200 г, а не 45
    if (g > 0 && (best == null || g > best)) best = g;
  }
  return best;
}

// Цена за кг и за штуку из строки чека. qty/unit/sum — то, что вернул GPT;
// packG — вес упаковки, если он есть в названии.
export function unitPricesFromLine(line) {
  const qty = num(line?.qty), sum = num(line?.sum);
  if (!sum) return { perKg: null, perPcs: null };
  const unit = String(line?.unit || '').toLowerCase().trim();
  const packG = packWeightG(line?.name);
  let perKg = null, perPcs = null;

  if (['кг', 'kg'].includes(unit) && qty) perKg = sum / qty;
  else if (['г', 'гр', 'g', 'мл', 'ml'].includes(unit) && qty) perKg = sum / (qty / 1000);
  else if (['л', 'l'].includes(unit) && qty) perKg = sum / qty;
  else {
    // штучная строка: «2 шт × 89,90»
    const n = qty || 1;
    perPcs = sum / n;
    if (packG) perKg = perPcs / (packG / 1000);
  }
  const round = v => (v ? Math.round(v * 100) / 100 : null);
  return { perKg: round(perKg), perPcs: round(perPcs) };
}

export const RECEIPT_PROMPT = `Ты распознаёшь кассовые чеки продуктовых магазинов. На фото/скриншоте — один чек.
Верни JSON: {"store": "название магазина или ''", "date": "YYYY-MM-DD или ''", "lines": [...]}.
Каждая строка покупки:
- name: название товара ТОЧНО как в чеке (с сокращениями и весом)
- product: обычное название продукта в единственном числе, без бренда, жирности, веса и упаковки ("Кур.филе охл.подл." → "куриное филе", "Молоко Простокваш.3,2% 930мл" → "молоко")
- qty: количество числом (1 если не указано)
- unit: единица из чека — одно из "кг|г|л|мл|шт"
- sum: итоговая сумма за строку числом, в рублях
Только строки с едой: пакеты, пакетированные услуги, скидки и итоги пропусти.
Если строка нечитаема — пропусти её, не выдумывай.`;

// Чистит ответ GPT: валидные строки, числа числами, ключ — канонический (тот
// же, что у списка покупок, чтобы цена цеплялась к позиции). Строки без
// суммы или без названия выбрасываем — лучше меньше, чем выдуманное.
export function normalizeReceipt(parsed, dict = null, now = new Date()) {
  const date = validDate(parsed?.date) || todayISO(now);
  const store = parsed?.store ? String(parsed.store).slice(0, 40) : '';
  const lines = [];
  for (const l of Array.isArray(parsed?.lines) ? parsed.lines : []) {
    const name = String(l?.name || l?.product || '').trim();
    const product = String(l?.product || l?.name || '').trim();
    if (!name || !num(l?.sum)) continue;
    const { perKg, perPcs } = unitPricesFromLine(l);
    if (!perKg && !perPcs) continue;
    lines.push({
      name, product,
      key: priceKeyFor(product || name, dict),
      qty: num(l?.qty) || 1,
      unit: String(l?.unit || 'шт').toLowerCase().trim(),
      sum: num(l.sum),
      perKg, perPcs,
    });
  }
  return { store, date, lines };
}

function validDate(v) {
  const s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) ? s : null;
}

// Ключ цены = канонический ключ списка покупок: «Молоко тёплое», «молоко» и
// «молоко 3,2%» — один товар и одна цена.
export function priceKeyFor(name, dict = null) {
  return canonicalShoppingKey(normalizeIngName(name), dict);
}

// Ручной ввод цены: «250», «250 ₽/кг», «89,90 за шт», «1,2 кг 300».
// Возвращает {perKg} или {perPcs} — по умолчанию цена за килограмм, потому
// что весовые продукты в списке преобладают.
export function parsePriceInput(text, defaultPer = 'kg') {
  const t = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const parsed = parseLeadingNumber(t.replace(',', '.'));
  if (!parsed) return null;
  const per = /шт|штук|уп|пачк|бут|десят/.test(t) ? 'pcs'
    : /кг|килог|литр|(^|\s)л(\s|$)/.test(t) ? 'kg' : defaultPer;
  const v = Math.round(parsed.num * 100) / 100;
  if (!(v > 0)) return null;
  return per === 'pcs' ? { perPcs: v } : { perKg: v };
}
