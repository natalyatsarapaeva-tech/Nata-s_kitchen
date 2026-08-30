// Чистая логика калорийности: без Firebase, тестируется в Node.
// Firestore-доступ живёт в nutrition.js, который реэкспортирует этот модуль.
import { normalizeIngName, parseLeadingNumber } from './utils.js';

// Граммы на единицу измерения. Ключи нормализованы: без пробелов и конечных точек.
const UNIT_TO_G = {
  'г':1,'гр':1,'g':1,
  'кг':1000,'kg':1000,
  'мл':1,'ml':1,
  'л':1000,'l':1000,
  'стакан':200,'стакана':200,'стаканов':200,
  'ч.л':5,'ст.л':15,
  'щепотка':1,'щепотки':1,'щепоток':1,
  // штучные кулинарные единицы
  'кочан':1200,'кочана':1200,'кочанов':1200,
  'банка':400,'банки':400,'банок':400,
  'зубчик':5,'зубчика':5,'зубчиков':5,
  'веточка':5,'веточки':5,'веточек':5,'веточку':5,
  'пучок':40,'пучка':40,'пучков':40,
  'горсть':30,'горсти':30,'горстей':30,
  'стебель':20,'стебля':20,'стеблей':20,
  'ломтик':20,'ломтика':20,'ломтиков':20,
  'лист':10,'листа':10,'листов':10,
};

// Дефолтный вес одного экземпляра (г) для частых штучных ингредиентов.
export const DEFAULT_UNIT_G = {
  'яйцо':60,'яйца':60,'яиц':60,'яйцо куриное':60,'яйца куриные':60,
  'картофель':150,'картошка':150,
  'морковь':80,'морковка':80,
  'лук':100,'лук репчатый':100,'луковица':100,'красный лук':100,
  'свёкла':200,'свекла':200,
  'помидор':100,'томат':100,'помидоры':100,'томаты':100,
  'огурец':100,'огурцы':100,
  'болгарский перец':150,'перец болгарский':150,
  'кабачок':250,'кабачки':250,'цукини':250,
  'баклажан':250,'баклажаны':250,
  'яблоко':150,'яблоки':150,
  'банан':120,'бананы':120,
  'апельсин':150,'апельсины':150,
  'лимон':80,'лимоны':80,
  'шампиньон':30,'шампиньоны':30,'гриб':30,'грибы':30,
  'чеснок':30, // головка; зубчик — через UNIT_TO_G
};

// Размерные множители к unitG ("2 крупных", "1 небольшой").
const SIZE_MULT = {
  'крупный':1.4,'крупная':1.4,'крупное':1.4,'крупных':1.4,
  'большой':1.4,'большая':1.4,'большое':1.4,'больших':1.4,
  'средний':1.0,'средняя':1.0,'среднее':1.0,'средних':1.0,
  'небольшой':0.75,'небольшая':0.75,'небольших':0.75,'небольшое':0.75,
  'маленький':0.6,'маленькая':0.6,'маленьких':0.6,'маленькое':0.6,
  'мелкий':0.6,'мелкая':0.6,'мелкое':0.6,'мелких':0.6,
};

function normalizeUnit(unit) {
  return unit.toLowerCase().replace(/\s+/g, '').replace(/\.+$/, '');
}

// "2 ст. л." → 30, "½ кочана" → 600, "3 шт" (unitG=60) → 180, "2 средних" → unitG*2.
export function amountToGrams(amountStr, unitG) {
  if (!amountStr) return null;
  const parsed = parseLeadingNumber(String(amountStr).toLowerCase());
  if (!parsed) return null;
  const num = parsed.num;

  // "2 средних (700 г)" — явный вес в скобках надёжнее любых оценок
  const parenG = String(amountStr).match(/\((?:~|≈)?\s*(\d+(?:[.,]\d+)?)\s*(?:г|гр)\.?\s*\)/i);
  if (parenG) return parseFloat(parenG[1].replace(',', '.'));

  // Первое слово после числа — единица измерения
  const rest = parsed.rest.trim();
  const unitWord = rest.split(/\s+/)[0] || '';
  const unit = normalizeUnit(rest.match(/^(ч|ст)\.?\s*л\.?/i) ? rest.match(/^(ч|ст)\.?\s*л\.?/i)[0] : unitWord);

  if (UNIT_TO_G[unit] != null) return num * UNIT_TO_G[unit];

  if (!unit || unit === 'шт' || unit === 'штук' || unit === 'штуки' || unit === 'штука') {
    return unitG ? num * unitG : (!unit ? num : null);
  }

  if (SIZE_MULT[unit] != null) return unitG ? num * unitG * SIZE_MULT[unit] : null;

  return null;
}

export const NUTRITION_PROMPT = `Ты диетолог. Верни ОДИН JSON-объект (без markdown, без пояснений), где каждый ключ — название ингредиента точно как в запросе, значение — объект:
- kcal: число (ккал на 100г)
- protein: число (г белков на 100г)
- fat: число (г жиров на 100г)
- carbs: число (г углеводов на 100г)
- fiber: число (г пищевых волокон на 100г)
- potassium: число (мг калия на 100г) — важно для почечной диеты
- phosphorus: число (мг фосфора на 100г) — важно для почечной диеты
- unitG: вес ОДНОГО среднего экземпляра в граммах — ОБЯЗАТЕЛЬНО для любого ингредиента который считают штуками или экземплярами: овощи, фрукты, яйца, грибы, и т.п. Примеры: яйцо=60, картофель=150, морковь=80, лук=100, свёкла=200, болгарский перец=150, помидор=100, огурец=100, кабачок=250, яблоко=150. Для сыпучих и жидких (мука, сахар, масло, молоко) — null.
Одно десятичное. Данные для сырых продуктов по USDA.`;

// Вызовы GPT переехали в js/gpt.js: там выбор между прокси-Worker'ом и
// личным ключом, а этот модуль остаётся чистым (тестируется в Node).

// Собирает валидный документ справочника из ответа GPT или null.
// Микроэлементы (клетчатка/калий/фосфор) — опциональны: пишутся, только
// если модель их вернула, чтобы не выдумывать нули для старых записей.
export function nutritionPayload(vals) {
  if (!vals || vals.kcal == null) return null;
  const num = v => (v != null && !isNaN(+v) ? +v : null);
  const out = {
    kcal: +vals.kcal, protein: +vals.protein || 0, fat: +vals.fat || 0, carbs: +vals.carbs || 0,
    ...(vals.unitG ? { unitG: +vals.unitG } : {})
  };
  for (const m of ['fiber', 'potassium', 'phosphorus']) {
    const v = num(vals[m]);
    if (v != null) out[m] = v;
  }
  return out;
}

// Микроэлементы, которые суммируются наравне с КБЖУ (на 100 г в справочнике).
export const MICROS = ['fiber', 'potassium', 'phosphorus'];

// Разворачивает список ингредиентов: строки-разделители вида
// "— ТЕСТО: Мука" превращаются в {divider:'ТЕСТО'} + {n:'Мука', a:…},
// чтобы ингредиент внутри разделителя не терялся ни в рендере, ни в расчёте.
// Структурированные поля (qty, unit, ing, opt) сохраняются.
export function expandIngredients(ingredients) {
  const out = [];
  for (const i of ingredients || []) {
    const n = (i.n || '').trim();
    if (!n) continue;
    if (n.startsWith('—')) {
      const body = n.replace(/^—\s*/, '');
      const colon = body.indexOf(':');
      if (colon >= 0) {
        out.push({ divider: body.slice(0, colon).trim() });
        const rest = body.slice(colon + 1).trim();
        if (rest) out.push({ ...i, n: rest, a: i.a || '' });
      } else {
        out.push({ divider: body });
      }
    } else {
      out.push({ ...i, n, a: i.a || '' });
    }
  }
  return out;
}

// ── СПРАВОЧНИК: чистые операции над загруженным словарём ──

// Собирает индекс синонимов из документов справочника {docId → data}.
export function buildDict(byKey) {
  const alias = {};
  for (const [k, v] of Object.entries(byKey)) {
    alias[k] = k;
    for (const a of v.aliases || []) if (!(a in alias)) alias[a] = k;
  }
  return { byKey, alias };
}

// Ищет запись справочника по каноническому ключу или синониму.
export function dictLookup(dict, key) {
  if (!dict || !key) return null;
  const k = dict.alias[key] || key;
  return dict.byKey[k] || null;
}

// Канонический ключ ингредиента для строки рецепта.
export function entryKey(entry) {
  return entry.ing || normalizeIngName(entry.n || '');
}

// Граммы на структурированную единицу (pcs — через unitG справочника).
const STRUCTURED_UNIT_G = { g: 1, ml: 1, tbsp: 15, tsp: 5, pinch: 1 };

// Граммы для строки рецепта: структурированные qty/unit в приоритете,
// свободный текст a — как fallback для немигрированных рецептов.
export function gramsForEntry(entry, dictDoc) {
  const unitG = dictDoc?.unitG
    || DEFAULT_UNIT_G[entryKey(entry)]
    || DEFAULT_UNIT_G[normalizeIngName(entry.n || '')];
  if (entry.qty != null && entry.unit) {
    if (entry.unit === 'pcs') return unitG ? entry.qty * unitG : null;
    if (STRUCTURED_UNIT_G[entry.unit] != null) return entry.qty * STRUCTURED_UNIT_G[entry.unit];
  }
  return amountToGrams(entry.a, unitG);
}

// КБЖУ рецепта: суммирует по строкам, возвращает totals + per-serving.
// Микроэлементы (клетчатка/калий/фосфор) суммируются, если есть в справочнике;
// microMissing[m] = true, когда часть продуктов их не имеет и сумма — нижняя
// оценка (в интерфейсе показываем «≥»). netCarbs = углеводы − клетчатка.
export function computeRecipeNutrition(recipe, dict) {
  const rows = [];
  const totals = { kcal: 0, protein: 0, fat: 0, carbs: 0, fiber: 0, potassium: 0, phosphorus: 0 };
  const microMissing = { fiber: false, potassium: false, phosphorus: false };
  let hasData = false, hasMissing = false;

  for (const i of expandIngredients(recipe.ingredients)) {
    if (!i.n) continue;
    const nut = dictLookup(dict, entryKey(i));
    if (!nut) { hasMissing = true; rows.push({ name: i.n, amount: i.a, unknown: true }); continue; }
    const grams = gramsForEntry(i, nut);
    let kcal = null, p = null, f = null, c = null;
    if (grams != null) {
      kcal = nut.kcal * grams / 100;
      p = nut.protein * grams / 100;
      f = nut.fat * grams / 100;
      c = nut.carbs * grams / 100;
      totals.kcal += kcal; totals.protein += p; totals.fat += f; totals.carbs += c;
      for (const m of MICROS) {
        if (nut[m] != null) totals[m] += nut[m] * grams / 100;
        else microMissing[m] = true;
      }
      hasData = true;
    }
    rows.push({ name: i.n, amount: i.a, grams, kcal, p, f, c });
  }

  const servings = Number(recipe.servings) > 0 ? Number(recipe.servings) : null;
  const per = key => totals[key] / servings;
  const perServing = hasData && servings ? {
    kcal: per('kcal'), protein: per('protein'), fat: per('fat'), carbs: per('carbs'),
    fiber: per('fiber'), potassium: per('potassium'), phosphorus: per('phosphorus'),
    netCarbs: Math.max(0, per('carbs') - per('fiber')),
  } : null;
  totals.netCarbs = Math.max(0, totals.carbs - totals.fiber);

  return { rows, totals, perServing, servings, hasData, hasMissing, microMissing };
}
