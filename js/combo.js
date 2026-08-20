// «Протеин + гарнир»: семья описывает отдельно гарниры (макароны, картошка,
// перловка, гречка, овсянка, киноа, тушёная капуста…) и виды белка (наггетсы,
// котлеты, рагу из мяса или бобов, стейки из рыбы…). Модуль чередует их,
// собирая разнообразные комбинации с учётом правил сочетаемости, и превращает
// каждую пару в примитивный регулярный рецепт — так планировщик недели уже
// умеет их ротировать (см. planner.js), считать покупки/КБЖУ и печатать.
// Чистая логика без Firebase — тестируется в Node.
import { cleanStructuredEntry } from './utils.js';
import { REGULAR_TAG, regularRecipeId } from './regular.js';

// ── Таксономия ──
// Гарниры делятся на крахмалистые (паста/картофель/злаки) и овощные; белок —
// на классы, близкие к attrs.mainProtein. Классификация нужна для правил
// сочетаемости и для равномерного чередования по категориям, а не только
// по конкретным блюдам.
export const SIDE_CATEGORIES = ['pasta', 'potato', 'grain', 'vegetable'];
export const PROTEIN_CATEGORIES = ['chicken', 'fish', 'seafood', 'meat', 'legumes', 'egg'];

// Определение категории по названию — работает и когда GPT не проставил
// category. ВАЖНО: \b в JS не дружит с кириллицей, поэтому ловим по префиксам.
// Порядок в списке = приоритет: специфичное раньше общего.
const SIDE_KEYWORDS = [
  ['pasta', /макарон|спагетт|паст[аеуы]|лапш|вермишел|пенне|фузилл|фарфалл|рожк|ньокк|тальятел|феттуч|кускус|кус-кус|булгур|птитим/],
  ['potato', /картоф|картош|пюре|драник|бул(ь|)б/],
  ['grain', /греч|(^|\s)рис|перловк|перлов|овсян|овся|киноа|кинуа|пшён|пшен|полб|манк|ячнев|ячк|кукурузн|булгур/],
  ['vegetable', /капуст|(^|\s)овощ|рагу.*овощ|овощн|брокколи|цветн|кабачк|стручков|тушён.*овощ|тушен.*овощ|гриль.*овощ|шпинат|цукини/],
];

const PROTEIN_KEYWORDS = [
  ['seafood', /кревет|мидии|мидий|кальмар|осьминог|гребешк|(^|\s)краб|устриц|морепродукт|лангуст/],
  ['fish', /рыб|лосос|сёмг|семг|форел|треск|тунец|тунц|скумбр|сельд|дорад|сибас|судак|минтай|палтус|камбал|горбуш|путассу|хек(\s|$)|филе.*рыб/],
  ['legumes', /фасол|чечевиц|(^|\s)нут[а]?(\s|$)|(^|\s)горох|бобы|бобов|(^|\s)маш(\s|$)|хумус|нутов/],
  ['egg', /яйц|яиц|омлет|глазунь|скрембл|фриттат/],
  ['chicken', /куриц|курин|цыпл|наггетс|нагетс|нагитс|индюш|индейк|утин|утк/],
  ['meat', /говя|свин|стейк|котлет|тефтел|фрикадельк|фарш|бекон|колбас|сосис|баран|ягн|телят|мясн|(^|\s)мяс[оа]?(\s|$)|гуляш|бефстроган|жарко|рагу|печен|кролик|биточк|шницел|люля/],
];

function classifyBy(keywords, title) {
  const t = ' ' + String(title || '').toLowerCase().trim() + ' ';
  for (const [cat, re] of keywords) if (re.test(t)) return cat;
  return null;
}

export function classifySide(title) {
  return classifyBy(SIDE_KEYWORDS, title);
}

export function classifyProtein(title) {
  return classifyBy(PROTEIN_KEYWORDS, title);
}

// ── Правила сочетаемости ──
// Заданы владельцем: рыба/морепродукты не идут с пастой; бобовым нужны овощи,
// а не злаки (сама бобовая часть — уже крахмал+белок, поэтому крахмалистый
// гарнир к ней избыточен). Всё остальное сочетается.
const FORBIDDEN = {
  fish: new Set(['pasta']),
  seafood: new Set(['pasta']),
  legumes: new Set(['grain', 'pasta', 'potato']),
};

export function pairAllowed(proteinCat, sideCat) {
  const f = FORBIDDEN[proteinCat];
  return !(f && f.has(sideCat));
}

// Человеческое объяснение, почему пара запрещена (для UI/подсказок).
export function pairReason(proteinCat, sideCat) {
  if (!pairAllowed(proteinCat, sideCat)) {
    if ((proteinCat === 'fish' || proteinCat === 'seafood') && sideCat === 'pasta')
      return 'рыба не сочетается с пастой';
    if (proteinCat === 'legumes')
      return 'к бобовым нужны овощи, а не крахмал';
    return 'неудачное сочетание';
  }
  return null;
}

// ── Сборка разнообразных комбинаций ──
// Из списков белков и гарниров собираем набор допустимых пар, упорядоченный
// «на разнообразие»: жадно берём пару, которая меньше всего повторяет уже
// использованные белок/гарнир и их категории (и никогда не ставит два
// одинаковых подряд), пока пары не кончатся или не наберём max. Порядок
// детерминированный — тай-брейк по исходному порядку, тесты воспроизводимы.
export function generateCombos(proteins, sides, { max = null } = {}) {
  const P = (proteins || [])
    .filter(p => p && String(p.title || '').trim())
    .map(p => ({ ...p, title: String(p.title).trim(), category: p.category || classifyProtein(p.title) }));
  const S = (sides || [])
    .filter(s => s && String(s.title || '').trim())
    .map(s => ({ ...s, title: String(s.title).trim(), category: s.category || classifySide(s.title) }));

  const allowed = [];
  for (const protein of P) {
    for (const side of S) {
      if (pairAllowed(protein.category, side.category)) allowed.push({ protein, side });
    }
  }
  if (!allowed.length) return [];

  const remaining = allowed.map((c, i) => ({ ...c, ord: i }));
  const out = [];
  const pUse = {}, sUse = {};
  let lastP = null, lastS = null, lastPC = null, lastSC = null;
  const limit = max != null ? Math.min(max, remaining.length) : remaining.length;

  while (out.length < limit && remaining.length) {
    let best = -1, bestScore = Infinity;
    remaining.forEach((c, i) => {
      let score = (pUse[c.protein.title] || 0) * 10 + (sUse[c.side.title] || 0) * 10;
      if (c.protein.title === lastP) score += 100;
      if (c.side.title === lastS) score += 100;
      if (c.protein.category && c.protein.category === lastPC) score += 4;
      if (c.side.category && c.side.category === lastSC) score += 4;
      score += c.ord * 0.001; // стабильный тай-брейк по исходному порядку
      if (score < bestScore) { bestScore = score; best = i; }
    });
    const [c] = remaining.splice(best, 1);
    out.push({ protein: c.protein, side: c.side });
    pUse[c.protein.title] = (pUse[c.protein.title] || 0) + 1;
    sUse[c.side.title] = (sUse[c.side.title] || 0) + 1;
    lastP = c.protein.title; lastS = c.side.title;
    lastPC = c.protein.category; lastSC = c.side.category;
  }
  return out;
}

// ── Комбинация → регулярный рецепт ──
// Класс белка → mainProtein (подсказка планировщику; сытность/класс всё равно
// уточняются по ингредиентам в suggest.js) и → тэг категории для списка/эмодзи.
const PROTEIN_TO_MAIN = {
  chicken: 'chicken', fish: 'fish', seafood: 'seafood',
  meat: 'beef', legumes: 'legumes', egg: 'none',
};
const PROTEIN_TO_TAG = {
  chicken: 'chicken', fish: 'fish', seafood: 'fish', meat: 'meat', legumes: 'veggie',
};
const PROTEIN_EMOJI = {
  chicken: '🍗', fish: '🐟', seafood: '🦐', meat: '🥩', legumes: '🫘', egg: '🍳',
};

export function comboTitle(protein, side) {
  return `${protein.title} + ${side.title}`;
}

// Собирает из пары примитивный регулярный рецепт: ингредиенты белка и гарнира
// объединяются и чистятся как при импорте; тэг «Регулярные» — всегда, id
// стабильный и пер-семейный (переразбор перезаписывает, а не плодит дубли).
export function comboToRecipe(combo, householdId = null, owner = null) {
  const { protein, side } = combo;
  const title = comboTitle(protein, side);
  const id = regularRecipeId(title, householdId);
  const ingredients = [...(protein.ingredients || []), ...(side.ingredients || [])]
    .map(cleanStructuredEntry).filter(i => i.n);
  const tag = PROTEIN_TO_TAG[protein.category];
  const servings = Number(protein.servings) > 0 ? Number(protein.servings)
    : (Number(side.servings) > 0 ? Number(side.servings) : null);
  return {
    id,
    emoji: protein.emoji || PROTEIN_EMOJI[protein.category] || '🍽️',
    title,
    meta: '',
    yield: '',
    note: '',
    tags: [...(tag ? [tag] : []), REGULAR_TAG],
    ingredients,
    steps: [`Приготовить ${protein.title.toLowerCase()}`, `Отдельно приготовить ${side.title.toLowerCase()}`, 'Подать вместе'],
    ...(servings ? { servings } : {}),
    attrs: {
      mealType: ['lunch', 'dinner'],
      mainProtein: PROTEIN_TO_MAIN[protein.category] || 'none',
    },
    combo: {
      protein: protein.title, side: side.title,
      proteinCategory: protein.category || null, sideCategory: side.category || null,
    },
    source: 'combo',
    ...(owner ? { createdBy: owner } : {}),
    ...(householdId ? { householdId } : {}),
  };
}

// Из готовых списков (например, разобранных GPT) собирает материализованные
// комбо-рецепты: пары → рецепты, отбрасывая пустые.
export function buildComboRecipes(proteins, sides, { householdId = null, owner = null, max = null } = {}) {
  return generateCombos(proteins, sides, { max })
    .map(c => comboToRecipe(c, householdId, owner))
    .filter(r => r.id && r.ingredients.length);
}

// ── LLM-парсер описания ──
// Семья одним текстом описывает и гарниры, и белки; GPT раскладывает их на два
// списка мини-заготовок (каждая со своими ингредиентами). Дальше сборка пар и
// правила сочетаемости — уже детерминированный код, не LLM.
export const COMBO_PROMPT = `Ты кулинарный ассистент. Семья описала, что ест на гарнир и какие виды белка любит — чтобы их чередовать в меню. Раздели описание на ДВА списка простых заготовок-компонентов. Верни ТОЛЬКО валидный JSON без markdown и пояснений:

{
  "sides": [{
    "title": "название гарнира на русском, коротко",
    "category": "одно из: ${SIDE_CATEGORIES.join('|')}",
    "emoji": "одно подходящее эмодзи",
    "servings": число порций (int),
    "ingredients": [{"n": "ингредиент", "a": "количество", "qty": число|null, "unit": "g|ml|pcs|tbsp|tsp|pinch"|null, "ing": "каноническое название: ед. число, нижний регистр", "opt": false}]
  }],
  "proteins": [{
    "title": "название белкового блюда на русском, коротко",
    "category": "одно из: ${PROTEIN_CATEGORIES.join('|')}",
    "emoji": "одно подходящее эмодзи",
    "servings": число порций (int),
    "ingredients": [{"n": "...", "a": "...", "qty": число|null, "unit": "...", "ing": "...", "opt": false}]
  }]
}

Категории гарниров: pasta — макароны/паста; potato — картофель в любом виде; grain — злаки и крупы (гречка, рис, перловка, овсянка, киноа, булгур); vegetable — овощные гарниры (тушёная капуста, овощное рагу, брокколи).
Категории белка: chicken — курица/индейка/наггетсы; fish — рыба; seafood — морепродукты; meat — говядина/свинина/котлеты/тефтели/рагу из мяса; legumes — бобовые (фасоль, чечевица, нут, рагу из бобов); egg — яйца/омлет.

Правила:
- Бери ТОЛЬКО компоненты из описания, ничего не выдумывай сверх него.
- Каждая заготовка примитивная: 1–5 ингредиентов с реалистичными количествами на указанное число порций (по умолчанию 4).
- Не объединяй белок и гарнир в одно блюдо — это разные списки.
- Все тексты на русском.`;

export function buildComboUserMsg(text) {
  return `Описание гарниров и белков семьи:\n"""\n${text}\n"""\nРаздели на два списка: sides (гарниры) и proteins (белок).`;
}

// Чистит ответ GPT: валидные title, категория — только из таксономии (иначе
// определяется по названию), ингредиенты чистятся как при импорте.
function cleanComponents(list, valid, classify) {
  return (Array.isArray(list) ? list : [])
    .filter(p => p && String(p.title || '').trim())
    .map(p => {
      const title = String(p.title).trim();
      const category = valid.includes(p.category) ? p.category : classify(title);
      const servings = parseInt(p.servings, 10);
      return {
        title,
        category,
        emoji: p.emoji || '',
        ...(servings > 0 ? { servings } : {}),
        ingredients: (p.ingredients || []).map(cleanStructuredEntry).filter(i => i.n),
      };
    })
    .filter(c => c.ingredients.length);
}

export function normalizeParsedCombo(parsed) {
  return {
    sides: cleanComponents(parsed?.sides, SIDE_CATEGORIES, classifySide),
    proteins: cleanComponents(parsed?.proteins, PROTEIN_CATEGORIES, classifyProtein),
  };
}
