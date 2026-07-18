// Недельный планировщик: чистые функции (без Firebase) — тестируются в Node.
// Заполнение сетки использует тот же скоринг, что и «Что приготовить?».
import { pickSuggestion } from './suggest.js';
import { expandIngredients, dictLookup, entryKey, gramsForEntry, computeRecipeNutrition } from './nutrition-core.js';

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const DAY_LABELS = { mon: 'Пн', tue: 'Вт', wed: 'Ср', thu: 'Чт', fri: 'Пт', sat: 'Сб', sun: 'Вс' };
export const MEAL_LABELS = { lunch: '🥪 Обед', dinner: '🍲 Ужин' };

// Понедельник недели, содержащей дату, в формате YYYY-MM-DD (локальное время).
export function weekStartISO(d = new Date()) {
  const date = new Date(d);
  date.setDate(date.getDate() - (date.getDay() + 6) % 7);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Сетка слотов из профиля семьи: какие приёмы пищи планируем.
export function buildSlots(profile) {
  const meals = profile?.planMeals?.length ? profile.planMeals : ['dinner'];
  const slots = [];
  for (const day of DAYS) {
    for (const meal of ['lunch', 'dinner']) {
      if (meals.includes(meal)) slots.push({ id: `${day}_${meal}`, day, meal });
    }
  }
  return slots;
}

// Заполняет незалоченные слоты недели. Залоченные сохраняются и участвуют
// в анти-повторах. Возвращает новый объект slots.
export function generateWeek(recipes, profile, existingSlots = {}, dict = null, now = Date.now(), rand = Math.random) {
  const slots = buildSlots(profile);
  const exclude = profile?.exclude || [];
  const out = {};
  const used = [];

  for (const s of slots) {
    const prev = existingSlots?.[s.id];
    if (prev?.locked && prev.recipeId) {
      out[s.id] = { ...prev };
      used.push(prev.recipeId);
    }
  }

  for (const s of slots) {
    if (out[s.id]) continue;
    const maxMin = s.meal === 'dinner' ? (profile?.rhythm?.[s.day] ?? null) : null;
    const res = pickSuggestion(recipes, { meal: s.meal, maxMin, exclude, dict }, [...used], now, rand);
    out[s.id] = res
      ? { recipeId: res.recipe.id, locked: false }
      : { recipeId: null, locked: false };
    if (res) used.push(res.recipe.id);
  }
  return out;
}

// Реролл одного слота: исключает рецепты, уже занятые в других слотах.
export function rerollSlot(recipes, profile, slots, slotId, dict = null, now = Date.now(), rand = Math.random) {
  const [day, meal] = slotId.split('_');
  const usedElsewhere = Object.entries(slots)
    .filter(([id, s]) => id !== slotId && s?.recipeId)
    .map(([, s]) => s.recipeId);
  const current = slots[slotId]?.recipeId;
  if (current) usedElsewhere.push(current); // не предлагать то же самое
  const maxMin = meal === 'dinner' ? (profile?.rhythm?.[day] ?? null) : null;
  const res = pickSuggestion(recipes, { meal, maxMin, exclude: profile?.exclude || [], dict }, usedElsewhere, now, rand);
  return res ? { recipeId: res.recipe.id, locked: false } : null;
}

// ── Список покупок ──
// Агрегирует ингредиенты всех блюд недели, исключая pantry staples.
// Структурированные qty/unit суммируются (шт отдельно, граммы отдельно);
// неразобранное — списком исходных строк.

export function aggregateShopping(slots, recipesById, dict) {
  const items = new Map();
  for (const slot of Object.values(slots || {})) {
    const r = slot?.recipeId ? recipesById[slot.recipeId] : null;
    if (!r) continue;
    for (const i of expandIngredients(r.ingredients)) {
      if (!i.n) continue;
      const key = entryKey(i);
      const d = dictLookup(dict, key);
      if (d?.isPantryStaple) continue;
      let item = items.get(key);
      if (!item) {
        item = { key, label: i.n, category: d?.category || 'other', pcs: 0, grams: 0, lines: [] };
        items.set(key, item);
      }
      if (i.qty != null && i.unit === 'pcs') item.pcs += i.qty;
      else {
        const g = gramsForEntry(i, d);
        if (g != null) item.grams += g;
        else if (i.a) item.lines.push(i.a);
      }
    }
  }
  return [...items.values()].sort((a, b) =>
    a.category.localeCompare(b.category) || a.label.localeCompare(b.label, 'ru'));
}

export function shoppingAmountLabel(item) {
  const parts = [];
  if (item.pcs) parts.push(`${Math.round(item.pcs * 10) / 10} шт`);
  if (item.grams) parts.push(item.grams >= 1000
    ? `${Math.round(item.grams / 100) / 10} кг`
    : `${Math.round(item.grams)} г`);
  for (const l of item.lines) parts.push(l);
  return parts.join(' + ') || '';
}

export const CATEGORY_LABELS = {
  vegetable: '🥦 Овощи', fruit: '🍎 Фрукты', meat: '🥩 Мясо', poultry: '🍗 Птица',
  fish: '🐟 Рыба', seafood: '🦐 Морепродукты', dairy: '🥛 Молочное', egg: '🥚 Яйца',
  grain: '🌾 Крупы и мука', legume: '🫘 Бобовые', nut: '🥜 Орехи', oil: '🫒 Масла',
  spice: '🌶 Специи', herb: '🌿 Зелень', sauce: '🥫 Соусы', sweet: '🍯 Сладкое',
  other: '📦 Прочее',
};

// Сводка недели: ккал на порцию по слотам с данными.
export function weekTotals(slots, recipesById, dict) {
  let kcal = 0, covered = 0, total = 0;
  for (const slot of Object.values(slots || {})) {
    const r = slot?.recipeId ? recipesById[slot.recipeId] : null;
    if (!r) continue;
    total++;
    const { perServing, totals, hasData, servings } = computeRecipeNutrition(r, dict);
    if (!hasData) continue;
    kcal += perServing ? perServing.kcal : (servings ? totals.kcal / servings : totals.kcal);
    covered++;
  }
  return { kcal, covered, total, perMealAvg: covered ? kcal / covered : 0 };
}
