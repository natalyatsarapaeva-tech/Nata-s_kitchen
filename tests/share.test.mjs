import test from 'node:test';
import assert from 'node:assert';
import { makeShareToken, isShareToken, readParam, shareSnapshot, shareLink,
  appRecipeLink, shareText, TOKEN_LENGTH, MAX_SHARE_IMAGE, SHARE_PARAM, APP_RECIPE_PARAM } from '../js/share.js';

const RECIPE = {
  id: 'tykvennyy-sup-123',
  emoji: '🍲',
  title: 'Тыквенный суп',
  meta: '~30 мин · 4 порции',
  yield: '4 порции',
  note: 'Не жалей имбиря',
  servings: 4,
  thumb: 'data:image/jpeg;base64,dGh1bWI=',
  tags: ['soup'],
  createdBy: 'uid-автора',
  householdId: 'family-7',
  needsReview: ['servings'],
  timesCooked: 12,
  ingredients: [
    { divider: 'СУП' },
    { n: 'Тыква', a: '600 г', ing: 'тыква', qty: 600, unit: 'g' },
    { n: '', a: '' },
  ],
  steps: ['Запечь тыкву', 'Пробить блендером', ''],
};

test('токен неугадываемой длины и проходит собственную проверку', () => {
  const token = makeShareToken();
  assert.strictEqual(token.length, TOKEN_LENGTH);
  assert.ok(isShareToken(token));
  assert.notStrictEqual(makeShareToken(), makeShareToken());
});

test('isShareToken отсекает мусор из адресной строки', () => {
  assert.ok(!isShareToken(''));
  assert.ok(!isShareToken('короткий'));
  assert.ok(!isShareToken('../../users/uid-жертвы'));
  assert.ok(!isShareToken('a'.repeat(15)));
  assert.ok(isShareToken('a'.repeat(16)));
});

test('readParam достаёт параметр из поиска и полного адреса', () => {
  assert.strictEqual(readParam('?r=abc', 'r'), 'abc');
  assert.strictEqual(readParam('?recipe=sup-1&x=2', 'recipe'), 'sup-1');
  assert.strictEqual(readParam('https://x.io/recipe.html?r=abc#top', 'r'), 'abc');
  assert.strictEqual(readParam('', 'r'), '');
  assert.strictEqual(readParam('?r=', 'r'), '');
});

test('снимок содержит рецепт и не выносит наружу служебные поля', () => {
  const snap = shareSnapshot(RECIPE, { token: 'tok', uid: 'uid-поделившегося', now: new Date('2026-01-02T03:04:05Z') });
  assert.strictEqual(snap.token, 'tok');
  assert.strictEqual(snap.recipeId, RECIPE.id);
  assert.strictEqual(snap.title, 'Тыквенный суп');
  assert.strictEqual(snap.servings, 4);
  assert.strictEqual(snap.createdAt, '2026-01-02T03:04:05.000Z');
  // createdBy — тот, кто поделился (по нему правила дают отозвать ссылку)
  assert.strictEqual(snap.createdBy, 'uid-поделившегося');
  assert.strictEqual(snap.householdId, undefined);
  assert.strictEqual(snap.needsReview, undefined);
  assert.strictEqual(snap.timesCooked, undefined);
  assert.strictEqual(snap.tags, undefined);
});

test('ингредиенты в снимке — только текст: разделители и пары название/количество', () => {
  const snap = shareSnapshot(RECIPE, { token: 't', uid: 'u' });
  assert.deepStrictEqual(snap.ingredients, [
    { divider: 'СУП' },
    { n: 'Тыква', a: '600 г' },   // qty/unit/ing наружу не уезжают
  ]);
  assert.deepStrictEqual(snap.steps, ['Запечь тыкву', 'Пробить блендером']);
});

test('в снимок едет большая картинка, а слишком тяжёлая заменяется аватаром', () => {
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(1000);
  const withBig = shareSnapshot(RECIPE, { token: 't', uid: 'u', image: big });
  assert.strictEqual(withBig.image, big);

  const huge = 'data:image/jpeg;base64,' + 'A'.repeat(MAX_SHARE_IMAGE);
  const withHuge = shareSnapshot(RECIPE, { token: 't', uid: 'u', image: huge });
  assert.strictEqual(withHuge.image, RECIPE.thumb, 'документ Firestore ≤ 1 МБ');

  const noPicture = shareSnapshot({ ...RECIPE, thumb: '' }, { token: 't', uid: 'u' });
  assert.strictEqual('image' in noPicture, false);
});

test('снимок пустого рецепта не падает', () => {
  const snap = shareSnapshot(null, {});
  assert.strictEqual(snap.title, '');
  assert.deepStrictEqual(snap.ingredients, []);
  assert.deepStrictEqual(snap.steps, []);
});

test('публичная ссылка ведёт на recipe.html рядом с приложением', () => {
  assert.strictEqual(shareLink('https://n.github.io/kitchen/index.html', 'tok'),
    `https://n.github.io/kitchen/recipe.html?${SHARE_PARAM}=tok`);
  // старые параметры и якорь из адреса приложения не утекают в ссылку
  assert.strictEqual(shareLink('https://n.github.io/kitchen/index.html?recipe=x#y', 'tok'),
    `https://n.github.io/kitchen/recipe.html?${SHARE_PARAM}=tok`);
  assert.strictEqual(shareLink('https://n.github.io/kitchen/', 'tok'),
    `https://n.github.io/kitchen/recipe.html?${SHARE_PARAM}=tok`);
});

test('вошедшего уводим в приложение на тот же рецепт', () => {
  assert.strictEqual(appRecipeLink('https://n.github.io/kitchen/recipe.html?r=tok', 'sup-1'),
    `https://n.github.io/kitchen/index.html?${APP_RECIPE_PARAM}=sup-1`);
  assert.strictEqual(readParam(appRecipeLink('https://n.io/k/recipe.html', 'су п'), APP_RECIPE_PARAM), 'су п');
});

test('текст для системного «Поделиться»', () => {
  assert.strictEqual(shareText(RECIPE), '🍲 Тыквенный суп (~30 мин · 4 порции)');
  assert.strictEqual(shareText({ title: 'Блины' }), '🍽️ Блины');
});
