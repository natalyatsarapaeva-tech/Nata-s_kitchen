// Прокси к OpenAI для Nata's Kitchen (Cloudflare Worker).
//
// Зачем: до него каждый член семьи вводил свой ключ OpenAI, и ключ лежал в
// localStorage — то есть был виден в devtools и уезжал вместе с устройством.
// Теперь ключ живёт в секрете Worker'а, а браузер доказывает право на вызов
// Firebase ID-токеном той же семьи, что уже вошла в приложение.
//
// Что проверяем на каждом запросе: источник (CORS), подпись токена по
// публичным ключам Google, claims (проект, срок), почту по белому списку,
// размер тела, модель и max_tokens, частоту вызовов. Всё, что не прошло, —
// 4xx без похода в OpenAI.
//
// Деплой и настройка — worker/README.md.
import {
  DEFAULT_ALLOWED_MODELS, MAX_BODY_BYTES, MAX_TOKENS_CAP,
  parseList, emailAllowed, originAllowed, validateBody, rateLimit,
  decodeJwt, base64UrlToBytes, checkClaims,
} from './guard.js';

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

// Кэш публичных ключей Google и счётчики частоты — на изолят.
let jwksCache = { keys: null, expires: 0 };
const rateHits = new Map();

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!originAllowed(origin, env.ALLOWED_ORIGINS)) return fail(403, 'Источник не разрешён', cors);
    if (request.method !== 'POST') return fail(405, 'Только POST', cors);

    const url = new URL(request.url);
    if (url.pathname !== '/v1/chat/completions') return fail(404, 'Неизвестный путь', cors);

    // 1. Кто пришёл
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const auth = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID);
    if (!auth.ok) return fail(401, auth.error, cors);
    if (!emailAllowed(auth.email, env.ALLOWED_EMAILS)) {
      return fail(403, env.ALLOWED_EMAILS
        ? 'Этой почте прокси не разрешён'
        : 'Прокси не настроен: задай ALLOWED_EMAILS', cors);
    }

    // 2. Как часто
    const rl = rateLimit(rateHits.get(auth.uid), Date.now(),
      Number(env.RATE_MAX_REQUESTS) || undefined);
    if (!rl.allowed) {
      rateHits.set(auth.uid, rl.hits);
      return fail(429, 'Слишком много запросов, подожди минуту', {
        ...cors, 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)),
      });
    }
    rateHits.set(auth.uid, rl.hits);

    // 3. Что просит
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return fail(413, 'Запрос слишком большой', cors);
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return fail(400, 'Тело не разобрано как JSON', cors); }
    const checked = validateBody(parsed, {
      models: parseList(env.ALLOWED_MODELS).length ? parseList(env.ALLOWED_MODELS) : DEFAULT_ALLOWED_MODELS,
      maxTokensCap: Number(env.MAX_TOKENS_CAP) || MAX_TOKENS_CAP,
    });
    if (!checked.ok) return fail(400, checked.error, cors);

    // 4. В OpenAI под нашим ключом
    const upstream = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify(checked.body),
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  },
};

function corsHeaders(origin, env) {
  const allowed = parseList(env.ALLOWED_ORIGINS);
  const value = !allowed.length ? '*'
    : (allowed.includes(origin.toLowerCase()) ? origin : allowed[0]);
  return {
    'Access-Control-Allow-Origin': value,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function fail(status, message, headers) {
  // формат ошибки как у OpenAI — приложение уже умеет его показывать
  return new Response(JSON.stringify({ error: { message } }), {
    status, headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

// Публичные ключи Google для проверки подписи ID-токена. Кэшируем по
// max-age из ответа: они меняются раз в несколько часов.
async function getJwks() {
  if (jwksCache.keys && Date.now() < jwksCache.expires) return jwksCache.keys;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error('Не получить ключи Google');
  const data = await res.json();
  const maxAge = Number((res.headers.get('Cache-Control') || '').match(/max-age=(\d+)/)?.[1] || 3600);
  jwksCache = { keys: data.keys || [], expires: Date.now() + maxAge * 1000 };
  return jwksCache.keys;
}

async function verifyFirebaseToken(token, projectId) {
  if (!token) return { ok: false, error: 'Нужен Firebase ID-токен' };
  if (!projectId) return { ok: false, error: 'Прокси не настроен: нет FIREBASE_PROJECT_ID' };
  const jwt = decodeJwt(token);
  if (!jwt || jwt.header.alg !== 'RS256') return { ok: false, error: 'Неподдерживаемый токен' };

  let keys;
  try { keys = await getJwks(); } catch (e) { return { ok: false, error: e.message }; }
  const jwk = keys.find(k => k.kid === jwt.header.kid);
  if (!jwk) return { ok: false, error: 'Ключ подписи не найден' };

  const key = await crypto.subtle.importKey('jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key,
    base64UrlToBytes(jwt.signature), new TextEncoder().encode(jwt.signed));
  if (!valid) return { ok: false, error: 'Подпись токена не сошлась' };

  return checkClaims(jwt.payload, projectId);
}
