// Недельный планировщик: чистые функции (без Firebase) — тестируются в Node.
// Заполнение сетки использует тот же скоринг, что и «Что приготовить?».
import { pickSuggestion, isBatchDish } from './suggest.js';
import { expandIngredients, dictLookup, entryKey, gramsForEntry, computeRecipeNutrition } from './nutrition-core.js';

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const DAY_LABELS = { mon: 'Пн', tue: 'Вт', wed: 'Ср', thu: 'Чт', fri: 'Пт', sat: 'Сб', sun: 'Вс' };
export const MEAL_LABELS = { breakfast: '🌅 Завтрак', lunch: '🥪 Обед', dinner: '🍲 Ужин' };

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
    for (const meal of ['breakfast', 'lunch', 'dinner']) {
      if (meals.includes(meal)) slots.push({ id: `${day}_${meal}`, day, meal });
    }
  }
  return slots;
}

// Куда ставить разогрев батч-блюда: завтрак → завтрашний завтрак,
// обед/ужин → завтрашний обед, если планируется, иначе завтрашний ужин.
export function findReheatSlotId(profile, cookSlotId) {
  const [day, meal] = cookSlotId.split('_');
  const nextDay = DAYS[DAYS.indexOf(day) + 1];
  if (!nextDay) return null; // воскресный батч — разогрев уже в следующей неделе
  const ids = new Set(buildSlots(profile).map(s => s.id));
  const prefs = meal === 'breakfast' ? ['breakfast'] : ['lunch', 'dinner'];
  for (const m of prefs) {
    if (ids.has(`${nextDay}_${m}`)) return `${nextDay}_${m}`;
  }
  return null;
}

// Заполняет незалоченные слоты недели. Залоченные сохраняются и участвуют
// в анти-повторах. Батч-блюдо (isBatchDish) автоматически занимает слот
// разогрева на следующий день и получает пометку заморозки одной порции.
export function generateWeek(recipes, profile, existingSlots = {}, dict = null, now = Date.now(), rand = Math.random) {
  const slots = buildSlots(profile);
  const exclude = profile?.exclude || [];
  const out = {};
  const used = [];
  const byId = {};
  recipes.forEach(r => byId[r.id] = r);

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
    if (!res) { out[s.id] = { recipeId: null, locked: false }; continue; }

    const r = res.recipe;
    out[s.id] = { recipeId: r.id, locked: false };
    // каталог исчерпан → новый круг анти-повторов, а не один фаворит трижды
    if (res.relaxed === 'repeat') used.length = 0;
    used.push(r.id);

    if (isBatchDish(r)) {
      out[s.id].kind = 'batch';
      const reheatId = findReheatSlotId(profile, s.id);
      if (reheatId && !out[reheatId]) {
        out[reheatId] = { recipeId: r.id, locked: false, kind: 'reheat', linkedTo: s.id };
      }
    }
  }
  return out;
}

// Убирает разогревы, привязанные к слоту (при реролле/удалении блюда готовки).
export function clearBatchLinks(slotsMap, cookSlotId) {
  for (const [id, s] of Object.entries(slotsMap || {})) {
    if (s?.linkedTo === cookSlotId) slotsMap[id] = { recipeId: null, locked: false };
  }
  return slotsMap;
}

// Привязывает разогрев к батч-блюду, если целевой слот свободен и не залочен.
export function applyBatchLink(slotsMap, profile, cookSlotId, recipe) {
  if (!recipe || !isBatchDish(recipe)) return slotsMap;
  slotsMap[cookSlotId] = { ...slotsMap[cookSlotId], kind: 'batch' };
  const reheatId = findReheatSlotId(profile, cookSlotId);
  const target = reheatId ? slotsMap[reheatId] : null;
  if (reheatId && (!target || (!target.recipeId && !target.locked))) {
    slotsMap[reheatId] = { recipeId: recipe.id, locked: false, kind: 'reheat', linkedTo: cookSlotId };
  }
  return slotsMap;
}

// Сколько раз готовить рецепт для батча: 2 приёма на семью + 1 порция
// в заморозку, относительно выхода рецепта.
export function batchFactor(recipe, profile) {
  const perMeal = (profile?.members || []).reduce((s, m) => s + (+m.coeff || 1), 0) || 1;
  const needed = 2 * perMeal + 1;
  const servings = Number(recipe?.servings) > 0 ? Number(recipe.servings) : null;
  if (!servings) return 2;
  return Math.max(1, Math.ceil((needed / servings) * 2) / 2); // шаг 0.5
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

export function aggregateShopping(slots, recipesById, dict, profile = null) {
  const items = new Map();
  for (const slot of Object.values(slots || {})) {
    if (slot?.kind === 'reheat') continue; // ингредиенты учтены в слоте готовки
    const r = slot?.recipeId ? recipesById[slot.recipeId] : null;
    if (!r) continue;
    const factor = slot.kind === 'batch' ? batchFactor(r, profile) : 1;
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
      if (i.qty != null && i.unit === 'pcs') item.pcs += i.qty * factor;
      else {
        const g = gramsForEntry(i, d);
        if (g != null) item.grams += g * factor;
        else if (i.a) item.lines.push(factor > 1 ? `${i.a} ×${factor}` : i.a);
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
