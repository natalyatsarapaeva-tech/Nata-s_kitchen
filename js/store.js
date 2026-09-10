// Доступ к пер-семейным данным и авторизация.
//
// Модель (решение №1 роадмапа):
//   users/{uid}              — маппинг пользователь → семья: { householdId, email, name }
//   recipes/{id}             — ОБЩАЯ книга рецептов (одна на все семьи);
//                              createdBy = uid автора, только он редактирует;
//                              легаси-рецепты (createdBy 'default'/нет) — семьи 'default'
//   recipeImages/{id}        — большое фото блюда (аватар-квадрат лежит в самом
//                              рецепте, чтобы список не тащил мегабайты)
//   shares/{token}           — снимок одного рецепта для публичной ссылки
//   households/{hid}         — профиль семьи + ownerUid + joinCode (код приглашения)
//   households/{hid}/recipeState/{rid} — история готовки ЭТОЙ семьи
//   households/{hid}/plans/{weekStart} — недельные планы и списки покупок
//   households/{hid}/prices/{ключ}    — ориентиры цен семьи (чеки + ручной ввод)
//
// Семья 'default' существовала до auth: владелец «забирает» её при первом
// входе (claimLegacyHousehold), данные и история не мигрируются — остаются на месте.
import { db, doc, getDoc, setDoc, deleteDoc, deleteField, collection, getDocs, query, where,
  auth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from './firebase.js';
import { LEGACY_HOUSEHOLD_ID, canEditRecipeAs, makeJoinCode, makeHouseholdId, normalizeJoinCode } from './household-core.js';
import { makeShareToken, shareSnapshot } from './share.js';

export { LEGACY_HOUSEHOLD_ID, normalizeJoinCode };
export { overlayStates } from './household-core.js';

// ── Текущее состояние сессии ──
let currentUser = null;
let currentHouseholdId = null;

// Постоянный слушатель держит currentUser актуальным (вход/выход/рефреш).
onAuthStateChanged(auth, user => { currentUser = user; });

// Первый ответ Firebase Auth (восстановление сессии из браузера).
let firstAuth = null;
export function initAuth() {
  if (!firstAuth) firstAuth = new Promise(resolve => {
    const off = onAuthStateChanged(auth, user => { off(); currentUser = user; resolve(user); });
  });
  return firstAuth;
}

export function currentUid() { return currentUser?.uid || null; }
export function currentUserEmail() { return currentUser?.email || ''; }
export function householdId() { return currentHouseholdId; }

// Идентификатор автора для новых рецептов: uid, до входа — 'default'
// (страницы-инструменты в тестовом режиме).
export function ownerId() { return currentUser?.uid || LEGACY_HOUSEHOLD_ID; }

export function canEditRecipe(recipe) {
  return canEditRecipeAs(recipe, currentUid(), currentHouseholdId || LEGACY_HOUSEHOLD_ID);
}

// ── Вход/выход ──
// currentUser ставится сразу из credential: onAuthStateChanged срабатывает
// асинхронно, а вызывающий код идёт в resolveHousehold сразу после await.
export async function signInGoogle() {
  const cred = await signInWithPopup(auth, new GoogleAuthProvider());
  currentUser = cred.user;
  return cred;
}
export async function signInEmail(email, pass) {
  const cred = await signInWithEmailAndPassword(auth, email, pass);
  currentUser = cred.user;
  return cred;
}
export async function registerEmail(email, pass) {
  const cred = await createUserWithEmailAndPassword(auth, email, pass);
  currentUser = cred.user;
  return cred;
}
export function signOutUser() { return signOut(auth); }

// ── users/{uid}: маппинг на семью ──

// Возвращает householdId пользователя (и запоминает его) или null — тогда
// нужен онбординг (создать/присоединиться/забрать существующую).
export async function resolveHousehold() {
  const uid = currentUid();
  if (!uid) return null;
  const snap = await getDoc(doc(db, 'users', uid));
  const hid = snap.exists() ? snap.data().householdId : null;
  currentHouseholdId = hid || null;
  return currentHouseholdId;
}

async function bindUserToHousehold(hid) {
  const uid = currentUid();
  // merge: в этом же документе лежит карта публичных ссылок (см. shares ниже)
  await setDoc(doc(db, 'users', uid), {
    householdId: hid,
    email: currentUserEmail(),
    name: currentUser?.displayName || '',
  }, { merge: true });
  currentHouseholdId = hid;
}

// ── Онбординг: создать / присоединиться / забрать легаси-семью ──

export async function createHousehold(name) {
  const hid = makeHouseholdId(name);
  await setDoc(doc(db, 'households', hid), {
    ...DEFAULT_PROFILE,
    name: name || DEFAULT_PROFILE.name,
    ownerUid: currentUid(),
    joinCode: makeJoinCode(),
  });
  await bindUserToHousehold(hid);
  return hid;
}

// Находит семью по коду приглашения (для переселения рецепта): {hid,name}|null.
export async function findHouseholdByCode(rawCode) {
  const code = normalizeJoinCode(rawCode);
  if (code.length < 4) return null;
  const snap = await getDocs(query(collection(db, 'households'), where('joinCode', '==', code)));
  if (!snap.docs.length) return null;
  const d = snap.docs[0];
  return { hid: d.id, name: d.data().name || d.id };
}

// Переселяет регулярный рецепт в другую семью: меняет ТОЛЬКО householdId
// (id и автора не трогает). В firestore.rules это разрешено члену текущей
// семьи рецепта, даже если он не автор.
export async function reassignRecipeHousehold(recipeId, hid) {
  await setDoc(doc(db, 'recipes', recipeId), { householdId: hid }, { merge: true });
}

// Поиск семьи по коду приглашения; null — код не найден.
export async function joinHouseholdByCode(rawCode) {
  const code = normalizeJoinCode(rawCode);
  if (code.length < 4) return null;
  const snap = await getDocs(query(collection(db, 'households'), where('joinCode', '==', code)));
  if (!snap.docs.length) return null;
  const hid = snap.docs[0].id;
  await bindUserToHousehold(hid);
  return hid;
}

// Есть ли ещё не занятая легаси-семья (данные, накопленные до auth).
export async function legacyHouseholdUnclaimed() {
  const snap = await getDoc(doc(db, 'households', LEGACY_HOUSEHOLD_ID));
  return snap.exists() && !snap.data().ownerUid;
}

// Владелец при первом входе забирает семью 'default' со всей историей.
export async function claimLegacyHousehold() {
  const ref = doc(db, 'households', LEGACY_HOUSEHOLD_ID);
  const snap = await getDoc(ref);
  if (!snap.exists() || snap.data().ownerUid) return false;
  await setDoc(ref, { ownerUid: currentUid(), joinCode: makeJoinCode() }, { merge: true });
  await bindUserToHousehold(LEGACY_HOUSEHOLD_ID);
  return true;
}

// ── Профиль семьи ──

const DEFAULT_PROFILE = {
  name: 'Моя семья',
  members: [{ name: 'Я', coeff: 1 }],
  planMeals: ['dinner'],
  weekStartDay: 'mon',  // с какого дня начинается неделя плана
  weekendFull: true, // сб-вс планируют все три приёма независимо от planMeals
  // бюджет времени на ужин по дням (мин); null = не ограничено
  rhythm: { mon: 45, tue: 45, wed: 45, thu: 45, fri: 60, sat: null, sun: null },
  excludeText: '', // продукты-исключения, через запятую
  regularDishesText: '', // привычные блюда «из головы» — сырьё для парсера регулярных
  hideRegular: false,    // скрывать регулярные рецепты из общего списка
  substitutions: [],     // пер-семейные замены продуктов: [{from, to}]
  showMicros: false,     // показывать клетчатку/калий/фосфор (диабет/почки)
};

function hid() { return currentHouseholdId || LEGACY_HOUSEHOLD_ID; }

export async function loadHousehold() {
  const snap = await getDoc(doc(db, 'households', hid()));
  const data = snap.exists() ? snap.data() : {};
  return {
    ...DEFAULT_PROFILE,
    ...data,
    rhythm: { ...DEFAULT_PROFILE.rhythm, ...(data.rhythm || {}) },
    members: data.members?.length ? data.members : DEFAULT_PROFILE.members,
  };
}

export async function saveHousehold(profile) {
  await setDoc(doc(db, 'households', hid()), profile);
}

// ── История готовки (пер-семейный оверлей поверх общих рецептов) ──

export async function loadRecipeStates() {
  const snap = await getDocs(collection(db, 'households', hid(), 'recipeState'));
  const map = {};
  snap.docs.forEach(d => { map[d.id] = d.data(); });
  return map;
}

// Отметка «приготовили»: пишет ТОЛЬКО в recipeState семьи, не в общий рецепт.
export async function markCookedState(recipe) {
  const state = {
    timesCooked: (recipe.timesCooked || 0) + 1,
    lastCookedAt: new Date().toISOString(),
  };
  await setDoc(doc(db, 'households', hid(), 'recipeState', recipe.id), state, { merge: true });
  return state;
}

// ── Недельные планы ──

export async function loadPlan(weekStart) {
  const snap = await getDoc(doc(db, 'households', hid(), 'plans', weekStart));
  const plan = snap.exists() ? snap.data() : { weekStart, slots: {}, checked: {} };
  plan.notes = plan.notes || {}; // заметки приёмов пищи: {slotId: текст}
  return plan;
}

export async function savePlan(plan) {
  await setDoc(doc(db, 'households', hid(), 'plans', plan.weekStart), plan);
}

// ── Ориентиры цен (households/{hid}/prices/{канонический ключ}) ──
// Цены пер-семейные, а не в общем справочнике nutrition: они зависят от
// города, магазина и месяца — чужая цена на курицу нам не ориентир.

export async function loadPrices() {
  const snap = await getDocs(collection(db, 'households', hid(), 'prices'));
  const byKey = {};
  snap.docs.forEach(d => { byKey[d.id] = d.data(); });
  return byKey;
}

export async function savePriceDoc(key, data) {
  await setDoc(doc(db, 'households', hid(), 'prices', key), { ...data, key });
}

// ── Фото блюда ──
// Большая картинка лежит отдельным документом: список рецептов её не тянет,
// она грузится только когда открыли карточку. Квадратный аватар (thumb)
// пишется в сам рецепт — он нужен каталогу сразу.

export async function loadRecipeImage(recipeId) {
  const snap = await getDoc(doc(db, 'recipeImages', recipeId));
  return snap.exists() ? (snap.data().data || '') : '';
}

export async function saveRecipeImage(recipeId, dataUrl) {
  await setDoc(doc(db, 'recipeImages', recipeId), {
    data: dataUrl,
    createdBy: ownerId(),
    updatedAt: new Date().toISOString(),
  });
}

export async function deleteRecipeImage(recipeId) {
  await deleteDoc(doc(db, 'recipeImages', recipeId));
}

// Аватар в самом рецепте: merge, чтобы не задеть остальные поля.
export async function saveRecipeThumb(recipeId, thumb) {
  await setDoc(doc(db, 'recipes', recipeId), { thumb: thumb || deleteField() }, { merge: true });
}

// ── Публичные ссылки на рецепт ──
// Токены своих ссылок лежат в users/{uid}.shares — документ и так читает
// только сам пользователь, а лишний индекс/запрос по коллекции не нужен.

async function myShares() {
  const uid = currentUid();
  if (!uid) return {};
  const snap = await getDoc(doc(db, 'users', uid));
  return (snap.exists() && snap.data().shares) || {};
}

export async function myShareToken(recipeId) {
  return (await myShares())[recipeId] || null;
}

// Создаёт (или обновляет) публичный снимок рецепта и возвращает токен.
// Повторное «Поделиться» переиспользует токен — ссылка у людей не протухает,
// а содержимое снимка освежается.
export async function publishShare(recipe, { image = '', sharedBy = '' } = {}) {
  const uid = currentUid();
  if (!uid) throw new Error('Нужно войти, чтобы делиться рецептом');
  const token = (await myShareToken(recipe.id)) || makeShareToken();
  await setDoc(doc(db, 'shares', token), shareSnapshot(recipe, { token, uid, image, sharedBy }));
  await setDoc(doc(db, 'users', uid), { shares: { [recipe.id]: token } }, { merge: true });
  return token;
}

// Освежает снимок, если ссылка уже создана (после правки рецепта или фото).
// Молча ничего не делает, когда делиться ещё не пробовали.
export async function refreshShare(recipe, image = '', sharedBy = '') {
  const token = await myShareToken(recipe.id);
  if (!token) return null;
  const uid = currentUid();
  await setDoc(doc(db, 'shares', token), shareSnapshot(recipe, { token, uid, image, sharedBy }));
  return token;
}

// Отзыв ссылки: документ удаляется, старая ссылка перестаёт открываться.
export async function revokeShare(recipeId) {
  const uid = currentUid();
  const token = await myShareToken(recipeId);
  if (!token) return false;
  await deleteDoc(doc(db, 'shares', token));
  await setDoc(doc(db, 'users', uid), { shares: { [recipeId]: deleteField() } }, { merge: true });
  return true;
}
