// «Регулярные» блюда: семья свободным текстом описывает привычную еду,
// которую готовит из головы без рецептов; GPT превращает описание в
// примитивные рецепты с тэгом REGULAR_TAG. Такие рецепты — основа
// недельного меню (см. planner.js), а по желанию скрываются из общего
// списка (households.hideRegular). Чистая логика без Firebase — тестируется в Node.
import { cleanStructuredEntry } from './utils.js';
import { TAGS } from './constants.js';

export const REGULAR_TAG = 'regular';

export function isRegularRecipe(r) {
  return (r?.tags || []).includes(REGULAR_TAG);
}

// Категории, которые GPT может назначить регулярному блюду (сам тэг
// «Регулярные» добавляется всегда; десерты привычной едой не считаем).
const CATEGORY_IDS = TAGS.map(t => t.id)
  .filter(id => id !== REGULAR_TAG && id !== 'dessert' && id !== 'icecream');

// Стабильный id без метки времени: повторный разбор того же описания
// перезаписывает прежние рецепты, а не плодит дубликаты.
export function regularRecipeId(title) {
  return 'reg-' + String(title || '').toLowerCase()
    .replace(/[^а-яёa-z0-9]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// Сколько рецептов просил пользователь: целое 1–15 или null
// (null → «5–10, по числу блюд в описании»).
export function clampRegularCount(raw) {
  const n = parseInt(raw, 10);
  if (isNaN(n)) return null;
  return Math.min(15, Math.max(1, n));
}

export const REGULAR_PROMPT = `Ты кулинарный ассистент. Семья описала блюда, которые готовит регулярно по памяти, без рецептов. Преврати описание в простые короткие рецепты-заготовки для планировщика меню. Верни ТОЛЬКО валидный JSON без markdown и пояснений:

{"recipes": [{
  "title": "название блюда на русском, коротко",
  "emoji": "одно подходящее эмодзи",
  "category": "одно из: ${CATEGORY_IDS.join('|')}",
  "meta": "время и выход, например: ~30 мин · 4 порции",
  "yield": "выход, например: 4 порции",
  "servings": число порций (int),
  "note": "",
  "ingredients": [{"n": "ингредиент", "a": "количество", "qty": число|null, "unit": "g|ml|pcs|tbsp|tsp|pinch"|null, "ing": "каноническое название: ед. число, нижний регистр", "opt": false}],
  "steps": ["короткий шаг 1", "короткий шаг 2"],
  "attrs": {"mealType": ["breakfast"|"lunch"|"dinner"], "mainProtein": "chicken|beef|pork|fish|seafood|legumes|dairy|none", "cuisine": "...", "activeMin": int, "totalMin": int, "heaviness": "light|medium|heavy", "spiciness": 0-3, "dietFlags": [], "kidFriendly": bool}
}]}

Правила:
- Бери ТОЛЬКО блюда из описания, ничего не выдумывай сверх него.
- Рецепты примитивные: 3–8 ингредиентов с реалистичными количествами, 2–4 коротких шага.
- Если в описании есть детали (что кладут, на сколько человек, когда едят) — используй их, иначе типовой домашний вариант блюда.
- Все тексты на русском.`;

export function buildRegularUserMsg(text, count = null) {
  const ask = count
    ? `Составь ${count} рецептов (или меньше, если блюд в описании меньше — не выдумывай). Если блюд больше — выбери ${count} самых повседневных.`
    : 'Составь от 5 до 10 рецептов — по числу блюд в описании.';
  return `Описание привычных блюд семьи:\n"""\n${text}\n"""\n${ask}`;
}

// Превращает ответ GPT в валидные документы рецептов: тэг «Регулярные»
// добавляется всегда, категория — только из известного списка, строки
// ингредиентов чистятся как при импорте.
export function normalizeParsedRegular(parsed, owner = null) {
  const list = Array.isArray(parsed?.recipes) ? parsed.recipes : [];
  return list
    .filter(p => p && String(p.title || '').trim())
    .map(p => {
      const title = String(p.title).trim();
      const servings = parseInt(p.servings, 10);
      const category = CATEGORY_IDS.includes(p.category) ? [p.category] : [];
      return {
        id: regularRecipeId(title),
        emoji: p.emoji || '🍳',
        title,
        meta: p.meta || '',
        yield: p.yield || '',
        note: p.note || '',
        tags: [...category, REGULAR_TAG],
        ingredients: (p.ingredients || []).map(cleanStructuredEntry).filter(i => i.n),
        steps: (p.steps || []).filter(Boolean),
        ...(servings > 0 ? { servings } : {}),
        ...(p.attrs && typeof p.attrs === 'object' ? { attrs: p.attrs } : {}),
        source: 'regular',
        ...(owner ? { createdBy: owner } : {}),
      };
    })
    .filter(r => r.id !== 'reg-' && r.ingredients.length);
}
