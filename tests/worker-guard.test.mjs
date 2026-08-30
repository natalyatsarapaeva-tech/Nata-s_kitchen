import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emailAllowed, originAllowed, validateBody, rateLimit, checkClaims, decodeJwt,
  parseList, DEFAULT_ALLOWED_MODELS, MAX_TOKENS_CAP,
} from '../worker/src/guard.js';

const PROJECT = 'natas-kitchen';
const NOW = Date.parse('2026-08-30T12:00:00Z');
const sec = Math.floor(NOW / 1000);

test('emailAllowed: пустой список закрывает прокси для всех', () => {
  assert.equal(emailAllowed('mama@example.com', ''), false, 'fail-closed: без списка никого');
  assert.equal(emailAllowed('mama@example.com', undefined), false);
  assert.equal(emailAllowed('mama@example.com', 'mama@example.com, sister@example.com'), true);
  assert.equal(emailAllowed('MAMA@Example.com', 'mama@example.com'), true, 'регистр не важен');
  assert.equal(emailAllowed('stranger@example.com', 'mama@example.com'), false);
  assert.equal(emailAllowed('', 'mama@example.com'), false, 'токен без почты не проходит');
});

test('originAllowed: пусто — не ограничиваем, иначе точное совпадение', () => {
  assert.equal(originAllowed('https://x.github.io', ''), true);
  assert.equal(originAllowed('https://x.github.io', 'https://x.github.io'), true);
  assert.equal(originAllowed('https://evil.example', 'https://x.github.io'), false);
});

test('validateBody: только знакомая форма запроса, max_tokens режется', () => {
  const ok = validateBody({ model: 'gpt-4o', messages: [{ role: 'user', content: 'привет' }], max_tokens: 99999 });
  assert.equal(ok.ok, true);
  assert.equal(ok.body.max_tokens, MAX_TOKENS_CAP, 'потолок токенов');

  assert.equal(validateBody({ model: 'o3-pro', messages: [{}] }).ok, false, 'чужая модель');
  assert.equal(validateBody({ model: 'gpt-4o' }).ok, false, 'без messages');
  assert.equal(validateBody({ model: 'gpt-4o', messages: [] }).ok, false, 'пустые messages');
  assert.equal(validateBody(null).ok, false);
  assert.equal(validateBody({ model: 'gpt-4o', messages: [{}], max_tokens: 'много' }).ok, false);

  // stream приложение не умеет разбирать — вырезаем
  const streamed = validateBody({ model: 'gpt-4o', messages: [{}], stream: true });
  assert.equal(streamed.ok, true);
  assert.equal('stream' in streamed.body, false);

  // список моделей настраивается
  assert.equal(validateBody({ model: 'gpt-4o', messages: [{}] }, { models: ['gpt-4o-mini'] }).ok, false);
  assert.ok(DEFAULT_ALLOWED_MODELS.includes('gpt-4o-search-preview'), 'поиск рецептов в вебе — тоже наша модель');
});

test('rateLimit: скользящее окно на пользователя', () => {
  let hits = [];
  for (let i = 0; i < 20; i++) hits = rateLimit(hits, NOW, 20).hits;
  const blocked = rateLimit(hits, NOW, 20);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
  // через минуту окно уехало
  assert.equal(rateLimit(hits, NOW + 61000, 20).allowed, true);
});

test('checkClaims: свой проект, живой токен, есть пользователь', () => {
  const base = { iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: 'u1',
    email: 'mama@example.com', exp: sec + 3600, iat: sec - 10 };
  const ok = checkClaims(base, PROJECT, NOW);
  assert.deepEqual(ok, { ok: true, uid: 'u1', email: 'mama@example.com' });

  assert.equal(checkClaims({ ...base, aud: 'other-app' }, PROJECT, NOW).ok, false);
  assert.equal(checkClaims({ ...base, iss: 'https://securetoken.google.com/other' }, PROJECT, NOW).ok, false);
  assert.equal(checkClaims({ ...base, exp: sec - 3600 }, PROJECT, NOW).ok, false, 'истёкший');
  assert.equal(checkClaims({ ...base, sub: '' }, PROJECT, NOW).ok, false);
  assert.equal(checkClaims({ ...base, iat: sec + 3600 }, PROJECT, NOW).ok, false, 'из будущего');
  assert.equal(checkClaims(null, PROJECT, NOW).ok, false);
  // небольшой сдвиг часов прощаем
  assert.equal(checkClaims({ ...base, exp: sec - 30 }, PROJECT, NOW).ok, true);
});

test('decodeJwt: разбор частей, мусор не роняет', () => {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64({ sub: 'u1' })}.signature`;
  const jwt = decodeJwt(token);
  assert.equal(jwt.header.kid, 'k1');
  assert.equal(jwt.payload.sub, 'u1');
  assert.equal(jwt.signed, token.split('.').slice(0, 2).join('.'));
  assert.equal(decodeJwt('не.токен'), null);
  assert.equal(decodeJwt(''), null);
  assert.equal(decodeJwt('a.b.c'), null, 'не-JSON внутри');
});

test('parseList: списки из переменных окружения', () => {
  assert.deepEqual(parseList(' A@x.ru , b@x.ru ,, '), ['a@x.ru', 'b@x.ru']);
  assert.deepEqual(parseList(''), []);
  assert.deepEqual(parseList(undefined), []);
});
