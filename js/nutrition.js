// Firestore-доступ к справочнику ингредиентов (коллекция nutrition).
// Вся чистая логика — в nutrition-core.js (реэкспортируется отсюда,
// чтобы страницы импортировали один модуль).
import { db, doc, setDoc, getDoc, collection, getDocs } from './firebase.js';
import { normalizeIngName } from './utils.js';
import { nutritionPayload, buildDict } from './nutrition-core.js';
import { callNutritionGPT } from './gpt.js';

export * from './nutrition-core.js';
// Страницы импортируют вызовы GPT отсюда же, чтобы не знать про транспорт.
export { callJsonGPT, callNutritionGPT, chatCompletion, requireGptKey, usingProxy } from './gpt.js';

export async function getNutritionDoc(key) {
  const snap = await getDoc(doc(db, 'nutrition', key));
  return snap.exists() ? snap.data() : null;
}

export async function saveNutritionDoc(key, payload) {
  await setDoc(doc(db, 'nutrition', key), payload);
}

// Загружает весь справочник и строит индекс синонимов.
export async function loadIngredientDict() {
  const snap = await getDocs(collection(db, 'nutrition'));
  const byKey = {};
  snap.docs.forEach(d => { byKey[d.id] = d.data(); });
  return buildDict(byKey);
}

// Ищет КБЖУ для отсутствующих ингредиентов и сохраняет в Firestore.
// Возвращает map normalizedKey → payload для найденных.
export async function lookupAndSaveNutrition(names, apiKey) {
  const result = await callNutritionGPT(names, apiKey);
  const saved = {};
  for (const [name, vals] of Object.entries(result)) {
    const payload = nutritionPayload(vals);
    if (!payload) continue;
    const key = normalizeIngName(name);
    await saveNutritionDoc(key, payload);
    saved[key] = payload;
  }
  return saved;
}
