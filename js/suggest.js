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
// Каскад правил (специфичное раньше общего):
//   1. Энергия на порцию: >550 ккал или >25 г жира → сытное.
//   2. Супы: без мяса → лёгкие; с мясом → средние; с мясом и бобовыми
//      (фасоль/чечевица/нут/горох) → сытные.
//   3. Салаты: без мяса → лёгкие; с любым мясом → средние.
//   4. Свинина, бекон, колбаски, говядина, куриные/утиные/индюшачьи
//      ноги и бёдра → сытное. Любая паста → сытное.
//   5. Рыба/морепродукты и куриная/индюшачья грудка → среднее.
//   6. Овощное/молочное с небольшой энергией → лёгкое; остальное — среднее.
// Детекция по названиям ингредиентов — работает и для немигрированных.

// ВАЖНО: \b в JS не работает с кириллицей — используем (^|\s)…(\s|$).
const RE_HEAVY_MEAT = /свин|бекон|колбас|сосис|говя|стейк|панчетт|ветчин|баран|ягн|фарш/;
const RE_POULTRY = /курин|куриц|цыпл|индюш|индейк|утин|утк|гус/;
const RE_POULTRY_DARK = /бедр|бёдр|ножк|(^|\s)ног[иа]?(\s|$)|голен|окорочк/;
const RE_MEAT_OTHER = /мясн|(^|\s)мяс[оа]?(\s|$)|кролик|телят/;
const RE_FISH = /рыб|лосос|семг|сёмг|форел|треск|тунец|тунц|скумбр|сельд|дорад|сибас|судак|минтай|палтус|камбал|анчоус|кревет|мидии|мидий|кальмар|осьминог|гребешк|(^|\s)краб|лангуст|устриц/;
const RE_BREAST = /грудк/;
const RE_LEGUMES = /фасол|чечевиц|(^|\s)нут[а]?(\s|$)|(^|\s)горох|бобы|бобов/;
const RE_PASTA = /макарон|спагетт|лингвин|фузилл|пенне|фарфалл|тальятел|феттуч|лазань|паппардел|вермишел|ньокк|(^|\s)орзо(\s|$)|лапш|букатин|ригатон|равиол|тортеллин|каннеллон/;

const RE_TOMATO = /томат|помидор/;
const RE_MUSHROOM = /шампиньон|(^|\s)гриб|вешенк|лисичк|подберез|подосинов|белые грибы/;

// Общие сигналы рецепта по названиям ингредиентов, тегам и attrs.
export function recipeSignals(r) {
  const tags = r.tags || [];
  const protein = r.attrs?.mainProtein || null;
  const ings = expandIngredients(r.ingredients)
    .filter(i => i.n)
    .map(i => (normalizeIngName(i.n) + ' ' + (i.ing || '')).trim());
  const anyIng = re => ings.some(s => re.test(s));

  const hasHeavyMeat = anyIng(RE_HEAVY_MEAT)
    || ings.some(s => RE_POULTRY.test(s) && RE_POULTRY_DARK.test(s))
    || ['pork', 'beef', 'lamb'].includes(protein);
  const hasAnyMeat = hasHeavyMeat
    || anyIng(RE_POULTRY) || anyIng(RE_MEAT_OTHER)
    || ['chicken'].includes(protein)
    || tags.includes('meat') || tags.includes('chicken');
  return {
    hasHeavyMeat,
    hasAnyMeat,
    hasFish: anyIng(RE_FISH) || tags.includes('fish') || ['fish', 'seafood'].includes(protein),
    hasBreast: anyIng(RE_BREAST),
    hasLegumes: anyIng(RE_LEGUMES),
    hasPasta: anyIng(RE_PASTA) || tags.includes('pasta'),
    hasTomato: anyIng(RE_TOMATO),
    hasMushroom: anyIng(RE_MUSHROOM),
  };
}

export function effectiveHeaviness(r, dict = null) {
  const label = r.attrs?.heaviness || null;
  const tags = r.tags || [];
  const protein = r.attrs?.mainProtein || null;
  const { hasHeavyMeat, hasAnyMeat, hasFish, hasBreast, hasLegumes, hasPasta } = recipeSignals(r);

  const perServing = dict ? computeRecipeNutrition(r, dict).perServing : null;
  const kcal = perServing?.kcal ?? null;
  const fat = perServing?.fat ?? null;
  // «лёгкое» дополнительно требует небольшой энергии, когда данные есть
  const lowEnergy = (kcal == null || kcal <= 400) && (fat == null || fat <= 20);

  // 1. Данные о калориях сильнее любых эвристик
  if (kcal != null && kcal > 550) return 'heavy';
  if (fat != null && fat > 25) return 'heavy';

  // 2. Супы — явные правила пользователя
  if (tags.includes('soup')) {
    if (hasAnyMeat && hasLegumes) return 'heavy';
    if (hasAnyMeat) return 'medium';
    return lowEnergy ? 'light' : 'medium';
  }

  // 3. Салаты
  if (tags.includes('salad')) {
    if (hasAnyMeat) return 'medium';
    return lowEnergy ? 'light' : 'medium';
  }

  // 4. Тяжёлое мясо и паста
  if (hasHeavyMeat) return 'heavy';
  if (hasPasta) return 'heavy';

  // Метка GPT может только утяжелить (сырный пирог и т.п.), не облегчить
  if (label === 'heavy') return 'heavy';

  // 5. Рыба/морепродукты и грудка птицы
  if (hasFish || hasBreast) return 'medium';
  if (hasAnyMeat) return 'medium';

  // 6. Овощное/молочное — лёгкое при небольшой энергии; выпечка — нет
  const veggieish = tags.includes('veggie') || ['none', 'dairy', 'legumes'].includes(protein);
  if (veggieish && !tags.includes('baking') && lowEnergy && label !== 'medium') return 'light';

  return 'medium';
}

// Класс белка для недельных квот: мясо / рыба / вегетарианское.
export function proteinClass(r) {
  const s = recipeSignals(r);
  if (s.hasAnyMeat) return 'meat';
  if (s.hasFish) return 'fish';
  return 'veg';
}

// Ключ «белкового приёма» — конкретная белковая часть блюда. Для комбо-рецептов
// («Белок + гарнир», см. combo.js) это сам белок: одну и ту же белую рыбу на
// пару нельзя готовить свежей несколько раз за неделю только из-за разных
// гарниров. Для обычных рецептов ключа нет (null) — одинаковые рецепты и так
// не повторяются по id, а «белковый приём» произвольного блюда неопределим.
export function proteinKey(r) {
  const p = r?.combo?.protein;
  return p ? normalizeIngName(p) : null;
}

// ── Батч-блюда: «готовим один раз — едим три раза» ──
// Ужин сегодня + обед/ужин завтра + 1 порция в заморозку. Список форматов
// задан пользователем; детекция по названию блюда + сигналам ингредиентов.

// Безусловные форматы: завтраки впрок, запеканки, зимние закуски, кислые супы
const RE_BATCH_TITLE = /оладь|оладуш|вафл|маффин|запеканк|драник|сырник|чизкейк|винегрет|оливье|под шубой|рассольник/;
const RE_BATCH_STEW = /гуляш|бефстроган|жарко[ей]|оссобуко|особукко|рагу|карри|стью|stew|соус/;
const RE_SHCHI = /(^|\s)щи(\s|$)/;

export function isBatchDish(r) {
  const title = normalizeIngName(r.title || '');
  const tags = r.tags || [];
  if (RE_BATCH_TITLE.test(title) || RE_SHCHI.test(title)) return true;

  const s = recipeSignals(r);
  // мясные и птичьи рагу/соусы: гуляш, бефстроганов, жаркое, карри…
  if (s.hasAnyMeat && RE_BATCH_STEW.test(title)) return true;
  // супы с мясом и грибные супы
  if (tags.includes('soup') && (s.hasAnyMeat || s.hasMushroom)) return true;
  // мясо/птица в томатном соусе (кроме салатов)
  if (s.hasAnyMeat && s.hasTomato && !tags.includes('salad')) return true;
  return false;
}

// ── Фильтры ──
// opts: { meal: 'breakfast'|'lunch'|'dinner', maxMin: number|null,
//         mood: 'light'|'normal'|'hearty'|null, dict?: справочник для ккал }

// ── Желаемые ингредиенты («готовим из того, что есть») ──
// Пользователь вводит продукты через запятую; рецепт проходит, если содержит
// хотя бы один из 1–2 указанных, либо хотя бы два из 3+ указанных.

export function parseWantedIngredients(text) {
  return String(text || '').split(/[,;\n]+/)
    .map(s => normalizeIngName(s))
    .filter(s => s.length > 1);
}

export function wantedThreshold(n) {
  return n >= 3 ? 2 : (n >= 1 ? 1 : 0);
}

// Морфологичное сравнение слов: точное совпадение или общий префикс
// длиной >= max(4, короткое-2) — «кабачки»↔«кабачок», «помидор»↔«помидоры».
function wordsMatch(a, b) {
  if (a === b) return true;
  const minLen = Math.min(a.length, b.length);
  const need = Math.max(4, minLen - 2);
  let i = 0;
  while (i < minLen && a[i] === b[i]) i++;
  return i >= need;
}

// Фраза («куриная грудка») совпадает со строкой рецепта, только если
// КАЖДОЕ её значимое слово находит пару — «куриные крылья» не пройдут.
function phraseMatchesEntry(phraseWords, entryWords) {
  return phraseWords.every(w => entryWords.some(ew => wordsMatch(w, ew)));
}

// Возвращает список желаемых продуктов, найденных в рецепте.
export function matchWantedIngredients(recipe, wanted) {
  if (!wanted?.length) return [];
  const entries = expandIngredients(recipe.ingredients)
    .filter(i => i.n)
    .map(i => (normalizeIngName(i.n) + ' ' + (i.ing || '')).trim().split(/\s+/));
  return wanted.filter(w => {
    const pw = w.split(' ').filter(x => x.length > 2);
    if (!pw.length) return false;
    return entries.some(ew => phraseMatchesEntry(pw, ew));
  });
}

const MOOD_TO_HEAVINESS = { light: 'light', normal: 'medium', hearty: 'heavy' };
const EXCLUDED_TAGS = ['dessert', 'icecream']; // никогда не в выдаче «что приготовить»

export function filterCandidates(recipes, opts) {
  return (recipes || []).filter(r => {
    if ((r.tags || []).some(t => EXCLUDED_TAGS.includes(t))) return false;
    if (opts.meal && !mealTypesForRecipe(r).includes(opts.meal)) return false;
    if (opts.maxMin) {
      const min = recipeMinutes(r);
      if (min == null || min > opts.maxMin) return false;
    }
    if (opts.mood) {
      if (effectiveHeaviness(r, opts.dict || null) !== MOOD_TO_HEAVINESS[opts.mood]) return false;
    }
    if (opts.protein && proteinClass(r) !== opts.protein) return false;
    // Белковый приём уже занят на этой неделе (комбо с той же белковой частью) —
    // не готовим его свежим снова; второй раз он попадает в меню только как
    // разогрев вчерашнего (тот же рецепт, ставится напрямую, минуя фильтр).
    if (opts.excludeProteins?.size) {
      const pk = proteinKey(r);
      if (pk && opts.excludeProteins.has(pk)) return false;
    }
    if (opts.want?.length) {
      if (matchWantedIngredients(r, opts.want).length < wantedThreshold(opts.want.length)) return false;
    }
    // Исключённые продукты семьи (аллергии и т.п.) — жёстко, не ослабляется
    if (opts.exclude?.length) {
      if (matchWantedIngredients(r, opts.exclude).length > 0) return false;
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
// Возвращает { recipe, relaxed } | null.
// relaxed: null|'repeat'|'time'|'mood_override'.
// Сытность (mood) — жёсткий фильтр с одним исключением: если указаны
// желаемые продукты и в выбранной сытности с ними пусто, продукты
// побеждают — сытность снимается ('mood_override'), а UI передвигает
// бегунок на категорию найденного блюда. Без продуктов сытность
// не ослабляется никогда: пусто — честный пустой экран.

export function pickSuggestion(recipes, opts, excludeIds = [], now = Date.now(), rand = Math.random) {
  const excluded = new Set(excludeIds);
  const tryPick = (o, relaxed) => {
    const cands = filterCandidates(recipes, o).filter(r => !excluded.has(r.id));
    if (!cands.length) return null;
    const scored = cands.map(r => ({
      recipe: r,
      // больше совпавших желаемых продуктов → заметно выше в выдаче
      score: scoreRecipe(r, now)
        + (o.want?.length ? matchWantedIngredients(r, o.want).length * 30 : 0),
    })).sort((a, b) => b.score - a.score);
    return { recipe: pickWeighted(scored, rand).recipe, relaxed };
  };

  const wantSet = !!opts.want?.length;
  return tryPick(opts, null)
    || (excluded.size ? (excluded.clear(), tryPick(opts, 'repeat')) : null)
    || (wantSet && opts.mood ? tryPick({ ...opts, mood: null }, 'mood_override') : null)
    || (opts.maxMin ? tryPick({ ...opts, maxMin: null }, 'time') : null)
    || (wantSet && opts.mood && opts.maxMin
        ? tryPick({ ...opts, mood: null, maxMin: null }, 'mood_override') : null);
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
