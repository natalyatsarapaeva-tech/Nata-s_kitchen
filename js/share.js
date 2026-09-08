// Публичная ссылка на один рецепт (без доступа к остальному приложению).
//
// Как это устроено:
//   shares/{token} — снимок ОДНОГО рецепта, читается без входа (firestore.rules:
//                    allow get: if true). Больше по этой ссылке не видно ничего:
//                    ни книги рецептов, ни планов, ни семьи.
//   recipe.html?r=<token> — страница-просмотр этого снимка.
//   Вошедшего пользователя страница уводит в приложение
//   (index.html?recipe=<id>) — у него ссылка открывается как обычный рецепт,
//   со всеми кнопками, а не как урезанная «публичная» копия.
//
// Токен неугадываемый, ссылка отзывается («Отключить ссылку» удаляет документ).
// Модуль чистый — тестируется в Node.

import { storedLength } from './photo.js';

// В документе снимка кроме картинки лежат ещё шаги и ингредиенты, а лимит
// документа Firestore — 1 МБ: оставляем запас, иначе снимок не сохранится.
export const MAX_SHARE_IMAGE = 700 * 1024;

export const SHARE_PAGE = 'recipe.html';
export const SHARE_PARAM = 'r';          // recipe.html?r=<token>
export const APP_RECIPE_PARAM = 'recipe'; // index.html?recipe=<id>

// Без похожих друг на друга символов — ссылку иногда диктуют голосом.
const TOKEN_CHARS = 'abcdefghijkmnopqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789';
export const TOKEN_LENGTH = 22;

export function makeShareToken(rand = Math.random, len = TOKEN_LENGTH) {
  return Array.from({ length: len }, () => TOKEN_CHARS[Math.floor(rand() * TOKEN_CHARS.length)]).join('');
}

// Токен из адресной строки: только буквы и цифры разумной длины (чужой мусор
// в параметре не должен превращаться в путь к документу Firestore).
export function isShareToken(raw) {
  return /^[A-Za-z0-9]{16,64}$/.test(String(raw || ''));
}

// Значение query-параметра из строки поиска ('?r=abc' или полного URL).
export function readParam(search, name) {
  const s = String(search || '');
  const qs = s.includes('?') ? s.slice(s.indexOf('?') + 1) : s;
  const val = new URLSearchParams(qs.split('#')[0]).get(name);
  return val ? val.trim() : '';
}

// Ингредиенты в снимок: только то, что видно на странице рецепта. Служебные
// поля (канонический ключ, qty/unit для КБЖУ, householdId, авторство) наружу
// не уезжают — публичной странице они не нужны.
function publicIngredients(list) {
  return (list || []).map(i => {
    if (i && i.divider != null) return { divider: String(i.divider) };
    return { n: String(i?.n || ''), a: String(i?.a || '') };
  }).filter(i => i.divider != null || i.n);
}

// Снимок рецепта для публичной ссылки. image — большая картинка (data-URI);
// если она не влезает в документ, остаётся квадратный thumb.
export function shareSnapshot(recipe, { token, uid, image = '', sharedBy = '', now = new Date() } = {}) {
  const r = recipe || {};
  const thumb = r.thumb || '';
  const picture = image && storedLength(image) <= MAX_SHARE_IMAGE ? image : thumb;
  return {
    token,
    recipeId: r.id || '',
    createdBy: uid || '',            // кто поделился — он же может отозвать (rules)
    createdAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    title: r.title || '',
    emoji: r.emoji || '🍽️',
    meta: r.meta || '',
    yield: r.yield || '',
    note: r.note || '',
    ingredients: publicIngredients(r.ingredients),
    steps: (r.steps || []).map(s => String(s)).filter(Boolean),
    ...(r.servings > 0 ? { servings: r.servings } : {}),
    ...(picture ? { image: picture } : {}),
    ...(sharedBy ? { sharedBy } : {}),
  };
}

// Публичная ссылка рядом с текущей страницей приложения:
// https://…/index.html → https://…/recipe.html?r=<token>
export function shareLink(baseHref, token) {
  const url = new URL(SHARE_PAGE, baseHref);
  url.search = '';
  url.hash = '';
  url.searchParams.set(SHARE_PARAM, token);
  return url.toString();
}

// Ссылка «открыть рецепт в приложении» — сюда уводим вошедшего пользователя.
export function appRecipeLink(baseHref, recipeId) {
  const url = new URL('index.html', baseHref);
  url.search = '';
  url.hash = '';
  url.searchParams.set(APP_RECIPE_PARAM, recipeId);
  return url.toString();
}

// Текст для «Поделиться» в системном меню телефона.
export function shareText(recipe) {
  const title = recipe?.title || 'Рецепт';
  const meta = recipe?.meta ? ` (${recipe.meta})` : '';
  return `${recipe?.emoji || '🍽️'} ${title}${meta}`;
}
