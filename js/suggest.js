// «Что приготовить?» — чистая логика подбора: фильтры, скоринг, взвешенный
// случайный выбор, проверка похожести для «Удиви меня». Без Firebase — тестируется в Node.
import { normalizeIngName } from './utils.js';
import { expandIngredients, computeRecipeNutrition } from './nutrition-core.js';

// ── Приём пищи ──

export function mealTypeFromClock(hour) {
  if (hour < 11) return 'breakfast';
  if (hour < 16) return 'lunch';
  return 'dinner';
}

// Fallback-маппинг категорий на приёмы пищи для немигрированных рецептов.
const TAG_MEALS = {
  breakfast: ['breakfast'],
  soup: ['lunch', 'dinner'],
  salad: ['lunch', 'dinner'],
  veggie: ['lunch', 'dinner'],
  meat: ['lunch', 'dinner'],
  chicken: ['lunch', 'dinner'],
  fish: ['lunch', 'dinner'],
  pasta: ['lunch', 'dinner'],
  baking: ['breakfast', 'dessert', 'snack'],
  dessert: ['dessert', 'snack'],
  icecream: ['dessert', 'snack'],
};

export function mealTypesForRecipe(r) {
  const fromAttrs = r.attrs?.mealType;
  if (Array.isArray(fromAttrs) && fromAttrs.length) return fromAttrs;
  const fromTags = [...new Set((r.tags || []).flatMap(t => TAG_MEALS[t] || []))];
  return fromTags.length ? fromTags : ['breakfast', 'lunch', 'dinner'];
}

// ── Время приготовления ──
// attrs.totalMin в приоритете; для немигрированных — парсим meta ("~30 мин", "2 часа").

export function recipeMinutes(r) {
  const t = r.attrs?.totalMin;
  if (t != null && !isNaN(+t)) return +t;
  const m = (r.meta || '').toLowerCase();
  let mm = m.match(/(\d+(?:[.,]\d+)?)\s*час/);
  if (mm) return Math.round(parseFloat(mm[1].replace(',', '.')) * 60);
  mm = m.match(/(\d+)\s*мин/);
  if (mm) return +mm[1];
  return null;
}

// ── Сытность ──
// Строгая детерминированная классификация: light | medium | heavy.
// «Лёгкое» — только овощи/молочное/рыба/морепродукты с небольшим жиром
// и без десертного сахара; мясные блюда (гуляш, фрикадельки, жаркое)
// никогда не попадают в light, даже без разметки. Метка GPT
// (attrs.heaviness) уточняет, но не может нарушить эти правила.

const RED_MEAT = ['beef', 'pork', 'lamb'];
const LIGHT_PROTEINS = ['fish', 'seafood', 'dairy', 'legumes', 'none'];
const SWEET_TAGS = ['dessert', 'baking', 'icecream'];

export function effectiveHeaviness(r, dict = null) {
  const label = r.attrs?.heaviness || null;
  const tags = r.tags || [];

  // Белковый класс: из attrs, иначе грубо из категорий
  let p = r.attrs?.mainProtein || null;
  if (!p) {
    if (tags.includes('meat')) p = 'beef';
    else if (tags.includes('chicken')) p = 'chicken';
    else if (tags.includes('fish')) p = 'fish';
    else if (tags.includes('salad') || tags.includes('veggie')) p = 'none';
  }

  const perServing = dict ? computeRecipeNutrition(r, dict).perServing : null;
  const kcal = perServing?.kcal ?? null;
  const fat = perServing?.fat ?? null;

  if (label === 'heavy') return 'heavy';
  if (kcal != null && kcal > 550) return 'heavy';
  if (fat != null && fat > 25) return 'heavy';

  const sweet = SWEET_TAGS.some(t => tags.includes(t));
  const lightEligible = p != null && LIGHT_PROTEINS.includes(p) && !sweet;
  // жир до 20 г/порцию: «немного жира», но жирная рыба (лосось) не выпадает
  const lowEnergy = (kcal == null || kcal <= 400) && (fat == null || fat <= 20);
  if (lightEligible && lowEnergy && label !== 'medium') return 'light';

  return 'medium';
}

// ── Фильтры ──
// opts: { meal: 'breakfast'|'lunch'|'dinner', maxMin: number|null,
//         mood: 'light'|'normal'|'hearty'|null, dict?: справочник для ккал }

const MOOD_TO_HEAVINESS = { light: 'light', normal: 'medium', hearty: 'heavy' };

export function filterCandidates(recipes, opts) {
  return (recipes || []).filter(r => {
    if (opts.meal && !mealTypesForRecipe(r).includes(opts.meal)) return false;
    if (opts.maxMin) {
      const min = recipeMinutes(r);
      if (min == null || min > opts.maxMin) return false;
    }
    if (opts.mood) {
      if (effectiveHeaviness(r, opts.dict || null) !== MOOD_TO_HEAVINESS[opts.mood]) return false;
    }
    return true;
  });
}

// ── Скоринг ──
// Доминирует давность: недавно готовили → сильный штраф; давно → высокий балл.
// Ни разу не готовили → умеренная «новизна». Лёгкий буст за проверенность.

export function scoreRecipe(r, now = Date.now()) {
  const last = r.lastCookedAt ? Date.parse(r.lastCookedAt) : NaN;
  let freshness;
  if (isNaN(last)) {
    freshness = 55;
  } else {
    const days = (now - last) / 86400000;
    freshness = days < 5 ? Math.max(days * 2, 0) : Math.min(days / 21, 1) * 100;
  }
  const familiarity = Math.min(r.timesCooked || 0, 8) * 2;
  return freshness + familiarity;
}

// Взвешенный случайный выбор из top-N по скору — осмысленно, но не одинаково
// каждый вечер. rand инжектится для тестов.
export function pickWeighted(scored, rand = Math.random, topN = 5) {
  const top = scored.slice(0, topN);
  const total = top.reduce((s, x) => s + x.score + 1, 0);
  let roll = rand() * total;
  for (const x of top) {
    roll -= x.score + 1;
    if (roll <= 0) return x;
  }
  return top[top.length - 1];
}

// ── Подбор с честным ослаблением фильтров ──
// Возвращает { recipe, relaxed } | null. relaxed: null|'repeat'|'time'.
// Сытность (mood) — жёсткий фильтр и НИКОГДА не ослабляется автоматически:
// исчерпали варианты — идём по второму кругу в той же сытности; совсем
// пусто — null (UI показывает честный пустой экран с «Удиви меня»).

export function pickSuggestion(recipes, opts, excludeIds = [], now = Date.now(), rand = Math.random) {
  const excluded = new Set(excludeIds);
  const tryPick = (o, relaxed) => {
    const cands = filterCandidates(recipes, o).filter(r => !excluded.has(r.id));
    if (!cands.length) return null;
    const scored = cands.map(r => ({ recipe: r, score: scoreRecipe(r, now) }))
      .sort((a, b) => b.score - a.score);
    return { recipe: pickWeighted(scored, rand).recipe, relaxed };
  };

  return tryPick(opts, null)
    || (excluded.size ? (excluded.clear(), tryPick(opts, 'repeat')) : null)
    || (opts.maxMin ? tryPick({ ...opts, maxMin: null }, 'time') : null);
}

// Человеческая строка «почему это здесь».
export function whyLine(r, now = Date.now()) {
  const last = r.lastCookedAt ? Date.parse(r.lastCookedAt) : NaN;
  if (isNaN(last)) return 'ни разу не готовили — время попробовать';
  const days = Math.floor((now - last) / 86400000);
  if (days >= 14) return `давно не готовили — ${Math.floor(days / 7)} нед. назад`;
  if (days >= 5) return `не готовили ${days} дн.`;
  if (days >= 1) return `готовили ${days} дн. назад`;
  return 'готовили сегодня';
}

// ── Похожесть для «Удиви меня» ──

const TITLE_STOP = new Set(['с', 'и', 'в', 'из', 'на', 'под', 'по', 'для', 'со', 'без', 'или']);
const COMMON_INGS = new Set([
  'соль', 'сахар', 'вода', 'перец', 'перец чёрный', 'чёрный перец',
  'оливковое масло', 'растительное масло', 'подсолнечное масло',
  'сливочное масло', 'масло сливочное', 'мука', 'чеснок', 'лук', 'зелень',
]);

function titleTokens(t) {
  return new Set(normalizeIngName(t || '').split(' ').filter(w => w.length > 2 && !TITLE_STOP.has(w)));
}

function ingKeySet(recipe) {
  const keys = expandIngredients(recipe.ingredients)
    .filter(i => i.n)
    .map(i => i.ing || normalizeIngName(i.n))
    .filter(k => k && !COMMON_INGS.has(k));
  return new Set(keys);
}

// Кандидат похож на рецепт, если пересечение названий >= 60% или
// основных ингредиентов >= 70% (от меньшего набора).
export function isSimilar(candidate, recipe) {
  const a = titleTokens(candidate.title), b = titleTokens(recipe.title);
  if (a.size && b.size) {
    const inter = [...a].filter(x => b.has(x)).length;
    if (inter / Math.min(a.size, b.size) >= 0.6) return true;
  }
  const ai = ingKeySet(candidate), bi = ingKeySet(recipe);
  if (ai.size >= 3 && bi.size >= 3) {
    const inter = [...ai].filter(x => bi.has(x)).length;
    if (inter / Math.min(ai.size, bi.size) >= 0.7) return true;
  }
  return false;
}

export function similarInCatalog(candidate, recipes) {
  return (recipes || []).find(r => isSimilar(candidate, r)) || null;
}

// Компактный дайджест каталога для промпта «Удиви меня».
export function catalogDigest(recipes) {
  return (recipes || []).map(r => {
    const parts = [r.title];
    if (r.attrs?.mainProtein && r.attrs.mainProtein !== 'none') parts.push(r.attrs.mainProtein);
    if (r.attrs?.cuisine) parts.push(r.attrs.cuisine);
    return parts.join(' · ');
  }).join('\n');
}
