// Доступ к пер-семейным данным. До внедрения авторизации всё живёт в
// households/default — при появлении auth добавится маппинг user→household
// и правила доступа, схема не изменится.
//
// Разделение владения:
//   recipes/{id}            — общая книга рецептов (шарится между семьями);
//                             createdBy = автор, только он редактирует
//   households/{hid}        — профиль семьи: члены, ритм недели, исключения
//   households/{hid}/recipeState/{rid} — история готовки ЭТОЙ семьи
//   households/{hid}/plans/{weekStart} — недельные планы и списки покупок
import { db, doc, getDoc, setDoc, collection, getDocs } from './firebase.js';

export const HOUSEHOLD_ID = 'default';

// Идентификатор «текущего пользователя» до auth: совпадает с household.
export function ownerId() { return HOUSEHOLD_ID; }

// Может ли текущий пользователь редактировать рецепт.
// Рецепты без createdBy — легаси, считаются своими.
export function canEditRecipe(recipe) {
  return !recipe?.createdBy || recipe.createdBy === ownerId();
}

const DEFAULT_PROFILE = {
  name: 'Моя семья',
  members: [{ name: 'Я', coeff: 1 }],
  planMeals: ['dinner'],
  weekendFull: true, // сб-вс планируют все три приёма независимо от planMeals
  // бюджет времени на ужин по дням (мин); null = не ограничено
  rhythm: { mon: 45, tue: 45, wed: 45, thu: 45, fri: 60, sat: null, sun: null },
  excludeText: '', // продукты-исключения, через запятую
  regularDishesText: '', // привычные блюда «из головы» — сырьё для парсера регулярных
  hideRegular: false,    // скрывать регулярные рецепты из общего списка
};

export async function loadHousehold() {
  const snap = await getDoc(doc(db, 'households', HOUSEHOLD_ID));
  const data = snap.exists() ? snap.data() : {};
  return {
    ...DEFAULT_PROFILE,
    ...data,
    rhythm: { ...DEFAULT_PROFILE.rhythm, ...(data.rhythm || {}) },
    members: data.members?.length ? data.members : DEFAULT_PROFILE.members,
  };
}

export async function saveHousehold(profile) {
  await setDoc(doc(db, 'households', HOUSEHOLD_ID), profile);
}

// ── История готовки (пер-семейный оверлей поверх общих рецептов) ──

export async function loadRecipeStates() {
  const snap = await getDocs(collection(db, 'households', HOUSEHOLD_ID, 'recipeState'));
  const map = {};
  snap.docs.forEach(d => { map[d.id] = d.data(); });
  return map;
}

// Накладывает состояние семьи на рецепты. Легаси-поля timesCooked/lastCookedAt
// на самом рецепте служат fallback'ом до первой готовки (ленивая миграция).
export function overlayStates(recipes, states) {
  return recipes.map(r => {
    const s = states[r.id];
    return s ? { ...r, ...s } : r;
  });
}

// Отметка «приготовили»: пишет ТОЛЬКО в recipeState семьи, не в общий рецепт.
export async function markCookedState(recipe) {
  const state = {
    timesCooked: (recipe.timesCooked || 0) + 1,
    lastCookedAt: new Date().toISOString(),
  };
  await setDoc(doc(db, 'households', HOUSEHOLD_ID, 'recipeState', recipe.id), state, { merge: true });
  return state;
}

// ── Недельные планы ──

export async function loadPlan(weekStart) {
  const snap = await getDoc(doc(db, 'households', HOUSEHOLD_ID, 'plans', weekStart));
  const plan = snap.exists() ? snap.data() : { weekStart, slots: {}, checked: {} };
  plan.notes = plan.notes || {}; // заметки приёмов пищи: {slotId: текст}
  return plan;
}

export async function savePlan(plan) {
  await setDoc(doc(db, 'households', HOUSEHOLD_ID, 'plans', plan.weekStart), plan);
}
