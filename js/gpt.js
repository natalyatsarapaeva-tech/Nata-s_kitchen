// Единственная точка выхода в OpenAI. Два режима:
//
//   1. Прокси (Cloudflare Worker, папка worker/) — ключ живёт в секрете
//      Worker'а, браузер шлёт туда Firebase ID-токен. Никто не вводит ключ,
//      расход идёт с одного счёта, ключ не утекает из devtools.
//   2. Личный ключ в localStorage — как было до прокси. Работает, пока
//      GPT_PROXY_URL пуст, и остаётся резервом.
//
// Чтобы включить прокси: задеплой worker/ (см. worker/README.md) и впиши сюда
// его адрес. Для проверки до коммита хватит localStorage.gpt_proxy = 'https://…'.
import { auth } from './firebase.js';
import { getOpenAIKey, setOpenAIKey } from './utils.js';
import { NUTRITION_PROMPT } from './nutrition-core.js';

export const GPT_PROXY_URL = '';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

export function gptProxyUrl() {
  try { return localStorage.getItem('gpt_proxy') || GPT_PROXY_URL || ''; }
  catch { return GPT_PROXY_URL || ''; }
}

export function usingProxy() { return !!gptProxyUrl(); }

// Ключ для запроса: при прокси не нужен (возвращаем ''), иначе берём
// сохранённый или спрашиваем. null — пользователь отказался, вызов отменяем.
export function requireGptKey(promptText = 'OpenAI API Key (сохранится в браузере):') {
  if (usingProxy()) return '';
  const saved = getOpenAIKey();
  if (saved) return saved;
  const key = prompt(promptText);
  if (!key) return null;
  setOpenAIKey(key);
  return key;
}

// Один запрос к chat/completions — через прокси или напрямую.
// Через прокси уходит Firebase ID-токен: Worker пускает только своих.
export async function chatCompletion(body, apiKey) {
  const proxy = gptProxyUrl();
  let url = OPENAI_URL, authValue = `Bearer ${apiKey}`;
  if (proxy) {
    url = proxy.replace(/\/$/, '') + '/v1/chat/completions';
    const user = auth.currentUser;
    if (!user) throw new Error('Нужно войти в приложение — запросы к GPT идут от имени семьи.');
    authValue = `Bearer ${await user.getIdToken()}`;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': authValue },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  return res.json();
}

// Универсальный JSON-вызов GPT: system-промпт + user-сообщение → объект.
// user — строка или массив content-блоков OpenAI (текст + image_url):
// так же вызывается распознавание чека по фото (js/prices.js, index.html).
export async function callJsonGPT(system, user, apiKey, maxTokens = 3000) {
  const data = await chatCompletion({
    model: 'gpt-4o', max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  }, apiKey);
  return JSON.parse(data.choices[0].message.content);
}

// Запрашивает у GPT КБЖУ для списка названий ингредиентов.
export async function callNutritionGPT(names, apiKey) {
  return callJsonGPT(NUTRITION_PROMPT,
    'Верни JSON с данными для всех этих ингредиентов: ' + names.join(', '), apiKey);
}
