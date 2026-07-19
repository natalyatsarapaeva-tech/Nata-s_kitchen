// Пер-семейные замены продуктов — слой ПОВЕРХ общей книги рецептов, без
// форка самих рецептов. Семья задаёт правила («мука → цельнозерновая мука»,
// «сахар → эритрит»), и приложение показывает рецепт, считает КБЖУ/микроэлементы
// и собирает список покупок уже с заменами. Оригинальный рецепт не меняется —
// у других семей он прежний. Чистая логика без Firebase — тестируется в Node.
import { normalizeIngName } from './utils.js';

// Собирает индекс замен из списка правил семьи в нормализованный map
// «канонический ключ исходного продукта → текст замены».
export function buildSubMap(subs) {
  const map = {};
  for (const s of subs || []) {
    const from = normalizeIngName(s?.from);
    const to = String(s?.to || '').trim();
    if (from && to) map[from] = to;
  }
  return map;
}

// Заменяет один ингредиент, если для него есть правило. Количество (qty/unit/a)
// сохраняется — семья при желании корректирует его руками. Разделители вида
// «— ТЕСТО: Мука» тоже поддержаны: заменяется продукт после двоеточия.
export function substituteEntry(entry, subMap) {
  if (!entry) return entry;
  const raw = String(entry.n || '').trim();
  if (!raw || !subMap) return entry;

  if (raw.startsWith('—')) {
    const colon = raw.indexOf(':');
    if (colon >= 0) {
      const prefix = raw.slice(0, colon + 1);
      const food = raw.slice(colon + 1).trim();
      const to = subMap[normalizeIngName(food)];
      if (to) return { ...entry, n: `${prefix} ${to}`, ing: normalizeIngName(to), origName: food };
    }
    return entry;
  }

  const to = subMap[entry.ing || normalizeIngName(raw)] || subMap[normalizeIngName(raw)];
  if (!to) return entry;
  return { ...entry, n: to, ing: normalizeIngName(to), origName: raw };
}

export function substituteIngredients(ingredients, subMap) {
  if (!subMap || !Object.keys(subMap).length) return ingredients || [];
  return (ingredients || []).map(e => substituteEntry(e, subMap));
}

// Копия рецепта с применёнными заменами (для рендера, КБЖУ и покупок).
// Пустой набор правил возвращает исходный рецепт как есть.
export function recipeWithSubs(recipe, subMap) {
  if (!recipe || !subMap || !Object.keys(subMap).length) return recipe;
  return { ...recipe, ingredients: substituteIngredients(recipe.ingredients, subMap) };
}
