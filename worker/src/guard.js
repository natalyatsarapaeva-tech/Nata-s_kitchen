// Проверки запроса к прокси — чистые функции без сети, тестируются в Node
// (tests/worker-guard.test.mjs) вместе со всем остальным кодом проекта.
//
// Прокси держит чужой платный ключ, поэтому по умолчанию он ЗАКРЫТ: пускаем
// только перечисленные почты. Firebase-проект разрешает саморегистрацию по
// email — без списка любой, кто нашёл сайт, тратил бы наши деньги.

export const DEFAULT_ALLOWED_MODELS = ['gpt-4o', 'gpt-4o-search-preview', 'gpt-4o-mini'];
export const MAX_BODY_BYTES = 12 * 1024 * 1024; // фото чеков в base64 — самые тяжёлые запросы
export const MAX_TOKENS_CAP = 8000;

// Лимит на пользователя: скользящее окно в памяти изолята. Не строгая
// гарантия (изолятов много и они умирают), но отсекает срыв цикла, который
// в отладке способен сжечь бюджет за минуты.
export const RATE_WINDOW_MS = 60 * 1000;
export const RATE_MAX_REQUESTS = 20;

export function parseList(value) {
  return String(value || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

// Кому можно. Пустой список = закрыто для всех (fail-closed).
export function emailAllowed(email, allowedList) {
  const allowed = parseList(allowedList);
  if (!allowed.length) return false;
  const e = String(email || '').trim().toLowerCase();
  return !!e && allowed.includes(e);
}

export function originAllowed(origin, allowedOrigins) {
  const allowed = parseList(allowedOrigins);
  if (!allowed.length) return true; // не задано — не ограничиваем по источнику
  return allowed.includes(String(origin || '').trim().toLowerCase());
}

// Тело запроса: разрешаем только знакомую форму chat/completions и режем
// max_tokens — прокси не должен уметь больше, чем нужно приложению.
export function validateBody(body, { models = DEFAULT_ALLOWED_MODELS, maxTokensCap = MAX_TOKENS_CAP } = {}) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Тело запроса должно быть JSON-объектом' };
  if (!models.includes(body.model)) return { ok: false, error: `Модель ${body.model || '—'} не разрешена` };
  if (!Array.isArray(body.messages) || !body.messages.length) return { ok: false, error: 'messages обязательны' };
  const out = { ...body };
  if (out.max_tokens != null) {
    const n = Number(out.max_tokens);
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'max_tokens должен быть числом' };
    out.max_tokens = Math.min(Math.round(n), maxTokensCap);
  }
  // stream ломает разбор ответа в приложении и усложняет прокси — не пускаем
  delete out.stream;
  return { ok: true, body: out };
}

// Скользящее окно: возвращает обновлённый список отметок и вердикт.
export function rateLimit(hits, now = Date.now(), max = RATE_MAX_REQUESTS, windowMs = RATE_WINDOW_MS) {
  const fresh = (hits || []).filter(t => now - t < windowMs);
  if (fresh.length >= max) return { allowed: false, hits: fresh, retryAfterMs: windowMs - (now - fresh[0]) };
  return { allowed: true, hits: [...fresh, now] };
}

// Разбор Firebase ID-токена без проверки подписи (её делает Worker через
// JWKS). Здесь — только структура и claims, чтобы это можно было тестировать.
export function decodeJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const json = s => JSON.parse(new TextDecoder().decode(base64UrlToBytes(s)));
    return { header: json(parts[0]), payload: json(parts[1]), signed: `${parts[0]}.${parts[1]}`, signature: parts[2] };
  } catch { return null; }
}

export function base64UrlToBytes(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(s).length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Claims Firebase ID-токена: издатель и аудитория — наш проект, срок жив,
// пользователь есть. skewSec прощает расхождение часов клиента и края.
export function checkClaims(payload, projectId, now = Date.now(), skewSec = 60) {
  if (!payload) return { ok: false, error: 'Токен не разобран' };
  const sec = Math.floor(now / 1000);
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) return { ok: false, error: 'Чужой издатель токена' };
  if (payload.aud !== projectId) return { ok: false, error: 'Токен выдан другому проекту' };
  if (!payload.sub) return { ok: false, error: 'В токене нет пользователя' };
  if (!(payload.exp > sec - skewSec)) return { ok: false, error: 'Токен истёк' };
  if (payload.iat && payload.iat > sec + skewSec) return { ok: false, error: 'Токен из будущего' };
  return { ok: true, uid: payload.sub, email: payload.email || '' };
}
