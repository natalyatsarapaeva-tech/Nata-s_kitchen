// Расчёт калорийности: перевод количеств в граммы, запросы к GPT,
// сохранение справочника nutrition в Firestore.
import { db, doc, setDoc, getDoc } from './firebase.js';
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
- unitG: вес ОДНОГО среднего экземпляра в граммах — ОБЯЗАТЕЛЬНО для любого ингредиента который считают штуками или экземплярами: овощи, фрукты, яйца, грибы, и т.п. Примеры: яйцо=60, картофель=150, морковь=80, лук=100, свёкла=200, болгарский перец=150, помидор=100, огурец=100, кабачок=250, яблоко=150. Для сыпучих и жидких (мука, сахар, масло, молоко) — null.
Одно десятичное. Данные для сырых продуктов по USDA.`;

// Запрашивает у GPT КБЖУ для списка названий ингредиентов.
export async function callNutritionGPT(names, apiKey) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o', max_tokens: 3000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: NUTRITION_PROMPT },
        { role: 'user', content: 'Верни JSON с данными для всех этих ингредиентов: ' + names.join(', ') }
      ]
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

// Собирает валидный документ nutrition из ответа GPT или null.
export function nutritionPayload(vals) {
  if (!vals || vals.kcal == null) return null;
  return {
    kcal: +vals.kcal, protein: +vals.protein || 0, fat: +vals.fat || 0, carbs: +vals.carbs || 0,
    ...(vals.unitG ? { unitG: +vals.unitG } : {})
  };
}

export async function getNutritionDoc(key) {
  const snap = await getDoc(doc(db, 'nutrition', key));
  return snap.exists() ? snap.data() : null;
}

export async function saveNutritionDoc(key, payload) {
  await setDoc(doc(db, 'nutrition', key), payload);
}

// Ищет КБЖУ для отсутствующих ингредиентов и сохраняет в Firestore.
// Возвращает map normalizedKey → payload для найденных.
export async function lookupAndSaveNutrition(names, apiKey) {
  const result = await callNutritionGPT(names, apiKey);
  const saved = {};
  for (const [name, vals] of Object.entries(result)) {
    const payload = nutritionPayload(vals);
    if (!payload) continue;
    const key = normalizeIngName(name);
    await saveNutritionDoc(key, payload);
    saved[key] = payload;
  }
  return saved;
}

// Разворачивает список ингредиентов: строки-разделители вида
// "— ТЕСТО: Мука" превращаются в {divider:'ТЕСТО'} + {n:'Мука', a:…},
// чтобы ингредиент внутри разделителя не терялся ни в рендере, ни в расчёте.
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
        if (rest) out.push({ n: rest, a: i.a || '' });
      } else {
        out.push({ divider: body });
      }
    } else {
      out.push({ n, a: i.a || '' });
    }
  }
  return out;
}
