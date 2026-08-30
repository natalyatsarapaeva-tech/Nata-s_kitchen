// Общие утилиты: экранирование HTML, разбор и масштабирование количеств.

export function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

export function normalizeIngName(name) {
  return String(name || '').toLowerCase()
    .replace(/[^Ѐ-ӿa-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Русское склонение после числа: pluralRu(3, ['строка','строки','строк']).
export function pluralRu(n, forms) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

// Единый id рецепта из названия (кириллица с ё, латиница, цифры).
export function slugify(title) {
  return title.toLowerCase()
    .replace(/[^а-яёa-z0-9]/gi, '-').replace(/-+/g, '-')
    .replace(/^-|-$/g, '') + '-' + Date.now();
}

const UNICODE_FRACTIONS = {
  '½':1/2,'⅓':1/3,'⅔':2/3,'¼':1/4,'¾':3/4,'⅕':1/5,'⅖':2/5,'⅗':3/5,'⅘':4/5,
  '⅙':1/6,'⅚':5/6,'⅐':1/7,'⅛':1/8,'⅜':3/8,'⅝':5/8,'⅞':7/8,'⅑':1/9,'⅒':1/10
};
const FRAC_CHARS = Object.keys(UNICODE_FRACTIONS).join('');

// Разбирает ведущее число в строке количества: "1 ½ ст. л.", "2/3 стакана",
// "1,5 ч. л.", "по 1 ч. л.", "200 г". Возвращает {num, rest, prefix} или null.
export function parseLeadingNumber(str) {
  if (!str) return null;
  let s = String(str).trim();
  let prefix = '';
  const pm = s.match(/^(по\s+|~\s*|≈\s*)/i);
  if (pm) { prefix = pm[1]; s = s.slice(pm[1].length); }

  let m = s.match(new RegExp(`^(\\d+)?\\s*([${FRAC_CHARS}])(.*)$`));
  if (m) return { num: (m[1] ? parseInt(m[1]) : 0) + UNICODE_FRACTIONS[m[2]], rest: m[3], prefix };

  m = s.match(/^(\d+)\s+(\d+)\/(\d+)(.*)$/);
  if (m) return { num: parseInt(m[1]) + parseInt(m[2]) / parseInt(m[3]), rest: m[4], prefix };

  m = s.match(/^(\d+)\/(\d+)(.*)$/);
  if (m) return { num: parseInt(m[1]) / parseInt(m[2]), rest: m[3], prefix };

  m = s.match(/^(\d+(?:[.,]\d+)?)(.*)$/);
  if (m) return { num: parseFloat(m[1].replace(',', '.')), rest: m[2], prefix };

  return null;
}

// Множитель из свободного ввода: "1/3", "0.5", "½", "2".
export function parseFractionInput(str) {
  const parsed = parseLeadingNumber(String(str || '').trim());
  if (!parsed || parsed.rest.trim() !== '') {
    const val = parseFloat(String(str || '').trim().replace(',', '.'));
    return isNaN(val) || val <= 0 ? null : val;
  }
  return parsed.num > 0 ? parsed.num : null;
}

export function formatScaledNumber(val) {
  const niceMap = [
    [1/8,'⅛'],[1/4,'¼'],[1/3,'⅓'],[3/8,'⅜'],
    [1/2,'½'],[5/8,'⅝'],[2/3,'⅔'],[3/4,'¾'],[7/8,'⅞']
  ];
  const intPart = Math.floor(val);
  const frac = val - intPart;
  if (frac < 0.04) return String(intPart === 0 ? (Math.round(val * 100) / 100) : intPart);
  for (const [f, sym] of niceMap) {
    if (Math.abs(frac - f) < 0.05) return intPart > 0 ? intPart + ' ' + sym : sym;
  }
  return String(Math.round(val * 10) / 10);
}

// Масштабирует строку количества: "200 г" ×2 → "400 г", "½ ч. л." ×2 → "1 ч. л."
export function scaleAmount(amountStr, multiplier) {
  if (!amountStr || multiplier === 1) return amountStr;
  const parsed = parseLeadingNumber(amountStr);
  if (!parsed) return amountStr;
  return parsed.prefix + formatScaledNumber(parsed.num * multiplier) + parsed.rest;
}

// Достаёт JSON-объект из ответа модели: срезает markdown-заборы и текст
// вокруг первого/последнего фигурного блока.
export function parseJsonLoose(raw) {
  const clean = String(raw || '').trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim();
  const start = clean.indexOf('{'), end = clean.lastIndexOf('}');
  return JSON.parse(start >= 0 && end > start ? clean.slice(start, end + 1) : clean);
}

// Чистит структурную строку ингредиента из ответа GPT: валидные qty/unit/ing/opt,
// без null-полей. n/a — исходный текст.
export function cleanStructuredEntry(e) {
  const out = { n: (e.n || '').trim(), a: (e.a || '').trim() };
  if (e.qty != null && !isNaN(+e.qty)) out.qty = +e.qty;
  if (e.unit && ['g','ml','pcs','tbsp','tsp','pinch'].includes(e.unit)) out.unit = e.unit;
  if (e.ing) out.ing = normalizeIngName(e.ing);
  if (e.opt) out.opt = true;
  return out;
}

// ── Ключ OpenAI ──
const OPENAI_KEY = 'openai_key';

export function getOpenAIKey() {
  // Миграция со старого имени ключа
  const legacy = localStorage.getItem('openai_api_key');
  if (legacy && !localStorage.getItem(OPENAI_KEY)) localStorage.setItem(OPENAI_KEY, legacy);
  return localStorage.getItem(OPENAI_KEY) || '';
}

export function setOpenAIKey(key) {
  if (key) localStorage.setItem(OPENAI_KEY, key.trim());
}
