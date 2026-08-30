// Тест самого обработчика Worker'а: настоящая подпись RS256, подставные
// JWKS и OpenAI. Проверяем то, ради чего прокси и заводится — что чужой
// запрос не доходит до платного ключа, а свой доходит без изменений.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import worker from '../worker/src/index.js';

const PROJECT = 'natas-kitchen';
const ORIGIN = 'https://natalyatsarapaeva-tech.github.io';
const KID = 'test-key';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });

const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');

function makeToken(claims = {}, key = privateKey) {
  const sec = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: KID, typ: 'JWT' };
  const payload = {
    iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT,
    sub: 'u1', email: 'mama@example.com', iat: sec - 10, exp: sec + 3600, ...claims,
  };
  const signed = `${b64(header)}.${b64(payload)}`;
  const sig = createSign('RSA-SHA256').update(signed).sign(key).toString('base64url');
  return `${signed}.${sig}`;
}

const ENV = {
  FIREBASE_PROJECT_ID: PROJECT,
  ALLOWED_ORIGINS: ORIGIN,
  ALLOWED_EMAILS: 'mama@example.com',
  OPENAI_API_KEY: 'sk-worker-secret',
  RATE_MAX_REQUESTS: '100', // лимит частоты живёт в модуле — не мешаем тестам друг другу
};

// Подставляем сеть: JWKS отдаёт наш публичный ключ, OpenAI — эхо запроса.
let openaiCalls = [];
function stubFetch() {
  openaiCalls = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('googleapis.com')) {
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] }),
        { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600' } });
    }
    openaiCalls.push({ url: String(url), headers: opts.headers, body: JSON.parse(opts.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

function req(body, { token, origin = ORIGIN, method = 'POST', path = '/v1/chat/completions' } = {}) {
  return new Request(`https://worker.example${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json', 'Origin': origin,
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

const GOOD_BODY = { model: 'gpt-4o', messages: [{ role: 'user', content: 'привет' }], max_tokens: 500 };

test('прокси: свой запрос доходит и уходит в OpenAI под ключом Worker\'а', async () => {
  stubFetch();
  const res = await worker.fetch(req(GOOD_BODY, { token: makeToken() }), ENV);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(openaiCalls.length, 1);
  assert.equal(openaiCalls[0].headers.Authorization, 'Bearer sk-worker-secret', 'наружу идёт ключ Worker\'а');
  assert.deepEqual(openaiCalls[0].body.messages, GOOD_BODY.messages, 'тело не искажается');
  const data = await res.json();
  assert.equal(data.choices[0].message.content, '{"ok":true}');
});

test('прокси: без токена, с чужой подписью и с чужой почтой — мимо OpenAI', async () => {
  stubFetch();
  const noToken = await worker.fetch(req(GOOD_BODY), ENV);
  assert.equal(noToken.status, 401);

  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const forged = await worker.fetch(req(GOOD_BODY, { token: makeToken({}, other.privateKey) }), ENV);
  assert.equal(forged.status, 401, 'подпись чужим ключом');
  assert.match((await forged.json()).error.message, /подпись/i);

  const stranger = await worker.fetch(req(GOOD_BODY, { token: makeToken({ email: 'stranger@example.com' }) }), ENV);
  assert.equal(stranger.status, 403, 'вошёл в Firebase, но не член семьи');

  const expired = await worker.fetch(req(GOOD_BODY, { token: makeToken({ exp: Math.floor(Date.now() / 1000) - 3600 }) }), ENV);
  assert.equal(expired.status, 401, 'истёкший токен');

  assert.equal(openaiCalls.length, 0, 'ни один отказ не сходил в OpenAI');
});

test('прокси: пустой ALLOWED_EMAILS закрывает всех (fail-closed)', async () => {
  stubFetch();
  const res = await worker.fetch(req(GOOD_BODY, { token: makeToken() }), { ...ENV, ALLOWED_EMAILS: '' });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error.message, /ALLOWED_EMAILS/);
  assert.equal(openaiCalls.length, 0);
});

test('прокси: чужой источник, чужой путь и чужая модель отсекаются', async () => {
  stubFetch();
  const badOrigin = await worker.fetch(req(GOOD_BODY, { token: makeToken(), origin: 'https://evil.example' }), ENV);
  assert.equal(badOrigin.status, 403);

  const badPath = await worker.fetch(req(GOOD_BODY, { token: makeToken(), path: '/v1/models' }), ENV);
  assert.equal(badPath.status, 404);

  const badModel = await worker.fetch(req({ ...GOOD_BODY, model: 'o3-pro' }, { token: makeToken() }), ENV);
  assert.equal(badModel.status, 400);

  assert.equal(openaiCalls.length, 0);
});

test('прокси: max_tokens режется потолком, preflight отвечает CORS', async () => {
  stubFetch();
  await worker.fetch(req({ ...GOOD_BODY, max_tokens: 999999 }, { token: makeToken() }), ENV);
  assert.equal(openaiCalls[0].body.max_tokens, 8000);

  const pre = await worker.fetch(req(null, { method: 'OPTIONS' }), ENV);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.match(pre.headers.get('Access-Control-Allow-Headers'), /Authorization/);
});
