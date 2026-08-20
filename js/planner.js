// Недельный планировщик: чистые функции (без Firebase) — тестируются в Node.
// Заполнение сетки использует тот же скоринг, что и «Что приготовить?».
import { pickSuggestion, isBatchDish, proteinClass, proteinKey, sideKey, effectiveHeaviness } from './suggest.js';
import { expandIngredients, dictLookup, entryKey, gramsForEntry, computeRecipeNutrition, DEFAULT_UNIT_G } from './nutrition-core.js';
import { isRegularRecipe } from './regular.js';

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
// По умолчанию (weekendFull !== false) суббота и воскресенье планируют
// все три приёма — в выходные семья ест дома; будни идут по planMeals.
export function buildSlots(profile) {
  const meals = profile?.planMeals?.length ? profile.planMeals : ['dinner'];
  const weekendAll = profile?.weekendFull !== false;
  const slots = [];
  for (const day of DAYS) {
    const dayMeals = weekendAll && (day === 'sat' || day === 'sun')
      ? ['breakfast', 'lunch', 'dinner'] : meals;
    for (const meal of ['breakfast', 'lunch', 'dinner']) {
      if (dayMeals.includes(meal)) slots.push({ id: `${day}_${meal}`, day, meal });
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

// ── Регулярные блюда как основа недели ──
// Если в каталоге есть рецепты с тэгом «Регулярные» (созданы из описания
// привычной еды семьи), неделя строится в основном из них, а рецепты из
// основной базы попадают в план дозированно: 2–4 блюда в неделю,
// равномерно распределённые по свободным слотам.
export const BASE_DISHES_MIN = 2;
export const BASE_DISHES_MAX = 4;

// Сколько блюд из основной базы положено на неделю из slotCount слотов.
export function baseWeekTarget(slotCount) {
  if (!slotCount) return 0;
  return Math.min(slotCount,
    Math.max(BASE_DISHES_MIN, Math.min(BASE_DISHES_MAX, Math.round(slotCount / 3))));
}

// Равномерно выбирает n слотов под «базовые» блюда из списка свободных.
export function pickBaseSlotIds(slotIds, n) {
  const out = new Set();
  const take = Math.min(Math.max(0, n), slotIds.length);
  if (!take) return out;
  const step = slotIds.length / take;
  for (let i = 0; i < take; i++) out.add(slotIds[Math.floor(step * (i + 0.5))]);
  return out;
}

// Следующий класс ужина по квотам: не повторяем вчерашний класс, если есть
// выбор; из доступных берём тот, которого осталось больше.
function nextDinnerClass(quota, lastClass) {
  const avail = ['meat', 'fish', 'veg'].filter(c => quota[c] > 0);
  if (!avail.length) return null;
  const pool = avail.filter(c => c !== lastClass);
  return (pool.length ? pool : avail).sort((a, b) => quota[b] - quota[a])[0];
}

// Заполняет незалоченные слоты недели. Залоченные сохраняются и участвуют
// в анти-повторах. Батч-блюдо (isBatchDish) автоматически занимает слот
// разогрева на следующий день и получает пометку заморозки одной порции.
// Квоты ужинов (profile.dinnerQuota = {meat, fish, veg}) распределяют классы
// по неделе без повторов подряд; мясные ужины чередуются между «обычное»
// и «сытное», начиная со среднего.
export function generateWeek(recipes, profile, existingSlots = {}, dict = null, now = Date.now(), rand = Math.random) {
  const slots = buildSlots(profile);
  const exclude = profile?.exclude || [];
  const out = {};
  const used = [];
  // Белковые приёмы и гарниры, уже занятые свежей готовкой на этой неделе:
  // один и тот же белок или гарнир (комбо) не готовим свежим повторно —
  // чтобы не было ни говядины всю неделю, ни киноа в каждом слоте. Второй раз
  // блюдо попадает только разогревом (тот же рецепт). См. proteinKey/sideKey.
  const usedProteins = new Set();
  const usedSides = new Set();
  const byId = {};
  recipes.forEach(r => byId[r.id] = r);

  for (const s of slots) {
    const prev = existingSlots?.[s.id];
    if (prev?.locked && prev.recipeId) {
      out[s.id] = { ...prev };
      used.push(prev.recipeId);
      if (prev.kind !== 'reheat') {
        const pk = proteinKey(byId[prev.recipeId]);
        if (pk) usedProteins.add(pk);
        const sk = sideKey(byId[prev.recipeId]);
        if (sk) usedSides.add(sk);
      }
    }
  }

  // Регулярные блюда — основа недели; базовые дозируются по baseWeekTarget.
  // Залоченные слоты с базовыми блюдами уже расходуют базовый лимит.
  const regularPool = recipes.filter(isRegularRecipe);
  const basePool = recipes.filter(r => !isRegularRecipe(r));
  const mixActive = regularPool.length > 0 && basePool.length > 0;
  let baseSlotSet = new Set();
  if (mixActive) {
    const lockedBase = slots.filter(s => {
      const slot = out[s.id];
      const r = slot?.recipeId ? byId[slot.recipeId] : null;
      return r && slot.kind !== 'reheat' && !isRegularRecipe(r);
    }).length;
    const freeIds = slots.filter(s => !out[s.id]).map(s => s.id);
    baseSlotSet = pickBaseSlotIds(freeIds, baseWeekTarget(slots.length) - lockedBase);
  }

  // Квоты ужинов: залоченные ужины уже расходуют свою квоту
  const q = profile?.dinnerQuota || null;
  const quota = { meat: Math.max(0, +q?.meat || 0), fish: Math.max(0, +q?.fish || 0), veg: Math.max(0, +q?.veg || 0) };
  const quotaActive = quota.meat + quota.fish + quota.veg > 0;
  let lastDinnerClass = null;
  let meatMood = 'normal'; // чередование мясных ужинов: средний → сытный → средний…
  if (quotaActive) {
    for (const s of slots) {
      if (s.meal !== 'dinner' || !out[s.id]?.recipeId) continue;
      const r = byId[out[s.id].recipeId];
      if (!r) continue;
      const cls = proteinClass(r);
      if (quota[cls] > 0) quota[cls]--;
      if (cls === 'meat') {
        meatMood = effectiveHeaviness(r, dict) === 'heavy' ? 'normal' : 'hearty';
      }
    }
  }

  for (const s of slots) {
    if (out[s.id]) {
      if (s.meal === 'dinner' && out[s.id].recipeId) {
        lastDinnerClass = proteinClass(byId[out[s.id].recipeId] || {});
      }
      continue;
    }
    const maxMin = s.meal === 'dinner' ? (profile?.rhythm?.[s.day] ?? null) : null;
    const base = { meal: s.meal, maxMin, exclude, dict, excludeProteins: usedProteins, excludeSides: usedSides };

    // Пул слота: в смешанном режиме регулярные — везде, кроме выделенных
    // «базовых» слотов; второй пул — честный fallback, если в первом пусто.
    const pool = mixActive ? (baseSlotSet.has(s.id) ? basePool : regularPool) : recipes;
    const altPool = mixActive ? (baseSlotSet.has(s.id) ? regularPool : basePool) : null;

    // Свежая попытка: повтор блюда ради сытности хуже, чем свежее без неё
    const freshFrom = (list, opts) => {
      if (!list?.length) return null;
      const p = pickSuggestion(list, opts, [...used], now, rand);
      return p && p.relaxed !== 'repeat' ? p : null;
    };
    const freshPick = opts => freshFrom(pool, opts);

    let res = null;
    let quotaCls = null;
    if (s.meal === 'dinner' && quotaActive) {
      const cls = nextDinnerClass(quota, lastDinnerClass);
      if (cls) {
        if (cls === 'meat') {
          // мясной ужин: сначала нужная сытность, потом любое свежее мясо
          res = freshPick({ ...base, protein: 'meat', mood: meatMood })
             || freshPick({ ...base, protein: 'meat' })
             || freshFrom(altPool, { ...base, protein: 'meat' })
             || pickSuggestion(pool, { ...base, protein: 'meat' }, [...used], now, rand);
        } else {
          res = freshPick({ ...base, protein: cls })
             || freshFrom(altPool, { ...base, protein: cls })
             || pickSuggestion(pool, { ...base, protein: cls }, [...used], now, rand);
        }
        if (res) {
          quotaCls = cls;
          quota[cls]--;
          if (cls === 'meat') meatMood = meatMood === 'normal' ? 'hearty' : 'normal';
        }
      }
    }
    if (!res) res = freshFrom(pool, base);
    if (!res && altPool) res = freshFrom(altPool, base);
    // Ступенчатый откат: если разнообразных пар не нашлось, ослабляем
    // ограничения по одному, а не оба разом — иначе нехватка гарниров
    // (мало круп) заодно разрешала бы повтор белка. Сначала жертвуем
    // гарниром (сохраняя разнообразие белка), потом наоборот.
    const noSides = { ...base, excludeSides: null };
    if (!res) res = freshFrom(pool, noSides);
    if (!res && altPool) res = freshFrom(altPool, noSides);
    const noProteins = { ...base, excludeProteins: null };
    if (!res) res = freshFrom(pool, noProteins);
    if (!res && altPool) res = freshFrom(altPool, noProteins);
    // Последний резерв: слот не должен пустовать — снимаем оба ограничения.
    const anyBase = { ...base, excludeProteins: null, excludeSides: null };
    if (!res) res = pickSuggestion(pool, anyBase, [...used], now, rand);
    if (!res && altPool) res = pickSuggestion(altPool, anyBase, [...used], now, rand);
    if (!res) { out[s.id] = { recipeId: null, locked: false }; continue; }

    const r = res.recipe;
    out[s.id] = { recipeId: r.id, locked: false };
    if (s.meal === 'dinner') lastDinnerClass = proteinClass(r);
    // каталог исчерпан → новый круг анти-повторов, а не один фаворит трижды
    if (res.relaxed === 'repeat') used.length = 0;
    used.push(r.id);
    const rpk = proteinKey(r);
    if (rpk) usedProteins.add(rpk);
    const rsk = sideKey(r);
    if (rsk) usedSides.add(rsk);

    if (isBatchDish(r)) {
      out[s.id].kind = 'batch';
      const reheatId = findReheatSlotId(profile, s.id);
      if (reheatId && !out[reheatId]) {
        // разогрев в ужин тоже расходует квоту класса; если квота исчерпана —
        // разогрев не ставим (порции уходят в заморозку)
        const rMeal = reheatId.split('_')[1];
        const cls = proteinClass(r);
        const allowed = rMeal !== 'dinner' || !quotaActive || quota[cls] >= 1;
        if (allowed) {
          out[reheatId] = { recipeId: r.id, locked: false, kind: 'reheat', linkedTo: s.id };
          if (rMeal === 'dinner' && quotaActive && quota[cls] > 0) quota[cls]--;
        }
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
// Класс белка текущего блюда сохраняется (мясной ужин остаётся мясным),
// с откатом до «любого», если в классе больше нечего предложить.
// Происхождение блюда тоже сохраняется: регулярное меняется на регулярное,
// базовое — на базовое; пустой слот пополняется из основы недели — регулярных.
export function rerollSlot(recipes, profile, slots, slotId, dict = null, now = Date.now(), rand = Math.random) {
  const [day, meal] = slotId.split('_');
  const usedElsewhere = Object.entries(slots)
    .filter(([id, s]) => id !== slotId && s?.recipeId)
    .map(([, s]) => s.recipeId);
  const current = slots[slotId]?.recipeId;
  if (current) usedElsewhere.push(current); // не предлагать то же самое
  const maxMin = meal === 'dinner' ? (profile?.rhythm?.[day] ?? null) : null;
  const byId = {};
  recipes.forEach(r => byId[r.id] = r);
  // Белок и гарнир соседних слотов (кроме разогревов) — не дублируем свежими
  // при перекатке; текущий слот не в счёт, его как раз меняем.
  const usedProteins = new Set();
  const usedSides = new Set();
  for (const [id, s] of Object.entries(slots)) {
    if (id === slotId || !s?.recipeId || s.kind === 'reheat') continue;
    const pk = proteinKey(byId[s.recipeId]);
    if (pk) usedProteins.add(pk);
    const sk = sideKey(byId[s.recipeId]);
    if (sk) usedSides.add(sk);
  }
  const base = { meal, maxMin, exclude: profile?.exclude || [], dict, excludeProteins: usedProteins, excludeSides: usedSides };
  const anyBase = { ...base, excludeProteins: null, excludeSides: null };
  const cur = current ? byId[current] : null;

  const regularPool = recipes.filter(isRegularRecipe);
  const mixActive = regularPool.length > 0 && regularPool.length < recipes.length;
  const pool = !mixActive ? recipes
    : (cur && !isRegularRecipe(cur) ? recipes.filter(r => !isRegularRecipe(r)) : regularPool);

  const res = (cur ? pickSuggestion(pool, { ...base, protein: proteinClass(cur) }, [...usedElsewhere], now, rand) : null)
    || pickSuggestion(pool, base, [...usedElsewhere], now, rand)
    || (mixActive ? pickSuggestion(recipes, base, usedElsewhere, now, rand) : null)
    // резерв без ограничения по белку — слот не должен остаться пустым
    || pickSuggestion(recipes, anyBase, [...usedElsewhere], now, rand);
  return res ? { recipeId: res.recipe.id, locked: false } : null;
}

// ── Список покупок ──
// Агрегирует ингредиенты всех блюд недели, исключая pantry staples.
// Структурированные qty/unit суммируются (шт отдельно, граммы отдельно);
// неразобранное — списком исходных строк.

// ── Канонизация ключа покупки ──
// «Молоко тёплое», «молоко (или растительное молоко)» и «молоко» — один
// товар; «яйца»/«яйцо»/«яиц» — один товар. Порядок: alias справочника →
// отрезать « или …» → убрать модификаторы → alias ещё раз → встроенные группы.

const SHOPPING_MODIFIERS = /^(тёплое|теплое|тёплый|теплый|тёплая|теплая|холодное|холодный|холодная|ледяная|ледяной|горячее|горячая|свежий|свежая|свежее|свежие|спелый|спелая|спелое|спелые|крупный|крупная|крупное|крупные|мелкий|мелкая|мелкие|небольшой|небольшая|небольшие|маленький|маленькая|маленькие|большой|большая|большие|сырой|сырая|сырые|молодой|молодая|молодые|средний|средняя|средние)$/;
const SHOPPING_GROUPS = [
  [/^яйц|^яиц/, 'яйцо'],
];

export function canonicalShoppingKey(key, dict) {
  let k = dict?.alias?.[key] || key;
  k = k.split(' или ')[0].trim();
  const words = k.split(/\s+/).filter(w => !SHOPPING_MODIFIERS.test(w));
  if (words.length) k = words.join(' ');
  k = dict?.alias?.[k] || k;
  for (const [re, canon] of SHOPPING_GROUPS) {
    if (re.test(k.split(' ')[0])) return canon;
  }
  return k;
}

export function aggregateShopping(slots, recipesById, dict, profile = null) {
  const items = new Map();
  for (const slot of Object.values(slots || {})) {
    if (slot?.kind === 'reheat') continue; // ингредиенты учтены в слоте готовки
    const r = slot?.recipeId ? recipesById[slot.recipeId] : null;
    if (!r) continue;
    const factor = slot.kind === 'batch' ? batchFactor(r, profile) : 1;
    for (const i of expandIngredients(r.ingredients)) {
      if (!i.n) continue;
      const rawKey = entryKey(i);
      const key = canonicalShoppingKey(rawKey, dict);
      const d = dictLookup(dict, key) || dictLookup(dict, rawKey);
      if (d?.isPantryStaple) continue;
      // штучный продукт (яйца, овощи с весом штуки) — покупается штуками
      const unitG = d?.unitG || DEFAULT_UNIT_G[key] || DEFAULT_UNIT_G[rawKey] || null;
      let item = items.get(key);
      if (!item) {
        item = { key, label: i.n, category: d?.category || 'other', pcs: 0, grams: 0, lines: [], unitG };
        items.set(key, item);
      }
      if (!item.unitG && unitG) item.unitG = unitG;
      // самое короткое написание — обычно самое каноничное («молоко», не «Молоко тёплое»)
      if (i.n.length < item.label.length) item.label = i.n;
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
  if (item.unitG && (item.pcs || item.grams)) {
    // штучный товар: граммы переводим в штуки, округляем вверх до целой
    parts.push(`${Math.ceil(item.pcs + item.grams / item.unitG)} шт`);
  } else {
    if (item.pcs) parts.push(`${Math.round(item.pcs * 10) / 10} шт`);
    if (item.grams) parts.push(item.grams >= 1000
      ? `${Math.round(item.grams / 100) / 10} кг`
      : `${Math.round(item.grams)} г`);
  }
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
