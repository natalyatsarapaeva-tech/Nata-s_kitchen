// Чистая логика мульти-семейности (без Firebase — тестируется в Node).
// Модель: users/{uid}.householdId → households/{hid}; рецепты живут в общей
// книге (коллекция recipes) и не копируются между семьями; правит только автор.

// Семья, существовавшая до внедрения auth. Её «забирает» владелец при первом
// входе (claim), легаси-рецепты с createdBy='default' принадлежат её членам.
export const LEGACY_HOUSEHOLD_ID = 'default';

// Может ли пользователь uid из семьи hid редактировать рецепт.
// Легаси-рецепты (без createdBy или 'default') — свои для членов легаси-семьи.
export function canEditRecipeAs(recipe, uid, hid) {
  const author = recipe?.createdBy;
  if (!author || author === LEGACY_HOUSEHOLD_ID) return hid === LEGACY_HOUSEHOLD_ID;
  return !!uid && author === uid;
}

// Код приглашения в семью: 6 символов без визуально похожих (I/L/O/0/1).
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function makeJoinCode(rand = Math.random) {
  return Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(rand() * CODE_CHARS.length)]).join('');
}

// Нормализация введённого кода: верхний регистр, без пробелов и лишних символов.
export function normalizeJoinCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Накладывает пер-семейную историю готовки на общие рецепты. Легаси-поля
// timesCooked/lastCookedAt на самом рецепте служат fallback'ом до первой
// готовки — но только для легаси-семьи: чужая история не должна казаться своей.
export function overlayStates(recipes, states, legacyFallback = true) {
  return recipes.map(r => {
    const s = states[r.id];
    if (s) return { ...r, ...s };
    if (legacyFallback) return r;
    const { timesCooked, lastCookedAt, ...rest } = r;
    return rest;
  });
}

// Id новой семьи: слаг имени + случайный хвост (уникальность без счётчиков).
export function makeHouseholdId(name, rand = Math.random) {
  const slug = String(name || 'семья').toLowerCase()
    .replace(/[^а-яёa-z0-9]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'семья';
  return `${slug}-${Math.floor(rand() * 1e9).toString(36)}`;
}
