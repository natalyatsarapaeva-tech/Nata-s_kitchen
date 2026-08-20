// GPT sanity-check недельного меню. Меню строит детерминированный планировщик
// (planner.js), а этот слой — «здравый смысл» поверх алгоритма: показывает GPT
// готовую неделю и просит отметить слоты, которые стоит перекатать, чтобы не
// было ни одного белка на всю неделю, ни одного гарнира по пять раз, и чтобы
// свежее/разогрев стояли осмысленно. GPT НЕ придумывает блюда и не трогает
// слоты сам — он лишь возвращает список слотов на замену, а перекатывает их
// детерминированный rerollSlot (который уже соблюдает разнообразие). Промпт
// редактируется на админ-странице; здесь — только значение по умолчанию,
// сериализация недели и разбор ответа. Чистая логика без Firebase.
import { DAYS, DAY_LABELS, MEAL_LABELS } from './planner.js';
import { proteinClass, proteinKey, sideKey } from './suggest.js';

// Редактируемый промпт по умолчанию (админ-страница может переопределить).
export const DEFAULT_MENU_CHECK_PROMPT = `Ты — придирчивый диетолог, который проверяет уже составленное недельное меню семьи на «здравый смысл» и разнообразие. Меню собрал алгоритм; твоя задача — найти слоты, которые стоит заменить, и вернуть их список. Ты НЕ придумываешь блюда сам.

Отметь слот на замену (reroll), если нарушено что-то из правил разнообразия:
- Один и тот же вид белка доминирует всю неделю (например, говядина в разных видах почти каждый день) — отметь лишние повторы.
- Один и тот же гарнир повторяется слишком часто (например, киноа 4–5 раз) — отметь лишние.
- Плохо чередуются злаки, овощи и виды белка (три дня подряд один тип гарнира или белка).
- Если в какой-то день на обед стоит РАЗОГРЕВ вчерашнего, то завтрак того же дня должен быть СВЕЖИМ. Если завтрак в такой день тоже разогрев — отметь завтрак.
- Одинаковые или почти одинаковые блюда стоят в соседних приёмах.

Правила ответа:
- Отмечай МИНИМУМ слотов — только те, что реально нарушают разнообразие. Если меню в целом хорошее, верни пустой список.
- НЕ отмечай слоты с пометкой «🔒 закреплено» и слоты-разогревы (они привязаны к готовке).
- Используй id слотов ровно как в списке (например, mon_dinner).

Верни ТОЛЬКО валидный JSON без markdown:
{"reroll": ["<id слота>", ...], "notes": "1–2 фразы на русском: что не так и что меняем"}`;

const PROTEIN_CLASS_RU = { meat: 'мясо', fish: 'рыба', veg: 'вегетарианское' };
const KIND_RU = { reheat: 'разогрев вчерашнего', batch: 'готовим впрок (батч)' };

function slotLine(slot, r, locked) {
  const parts = [];
  const pk = proteinKey(r), sk = sideKey(r);
  if (pk) parts.push(`белок: ${pk}`);
  else parts.push(`белок: ${PROTEIN_CLASS_RU[proteinClass(r)] || '—'}`);
  if (sk) parts.push(`гарнир: ${sk}`);
  parts.push(KIND_RU[slot.kind] || 'свежее');
  if (locked) parts.push('🔒 закреплено');
  return `«${r.title}» [${parts.join(' · ')}]`;
}

// Компактное текстовое описание недели для GPT: по дню и приёму пищи.
export function describeWeekForCheck(slots, recipesById) {
  const meals = ['breakfast', 'lunch', 'dinner'];
  const lines = [];
  for (const day of DAYS) {
    for (const meal of meals) {
      const id = `${day}_${meal}`;
      const slot = slots?.[id];
      if (!slot?.recipeId) continue;
      const r = recipesById[slot.recipeId];
      if (!r) continue;
      const mealLabel = (MEAL_LABELS[meal] || meal).replace(/^[^\wА-Яа-я]+/, '').trim();
      lines.push(`${id} — ${DAY_LABELS[day]} ${mealLabel}: ${slotLine(slot, r, slot.locked)}`);
    }
  }
  return lines.join('\n');
}

export function buildMenuCheckUserMsg(weekText) {
  return `Вот недельное меню (по одному слоту в строке, формат «id — День Приём: «блюдо» [детали]»):\n"""\n${weekText}\n"""\nПроверь на разнообразие и верни JSON со слотами на замену.`;
}

const SLOT_ID_RE = /^(mon|tue|wed|thu|fri|sat|sun)_(breakfast|lunch|dinner)$/;

// Разбирает ответ GPT: только валидные id слотов, дубли убираются.
export function parseMenuCheckResult(parsed) {
  const raw = Array.isArray(parsed?.reroll) ? parsed.reroll : [];
  const reroll = [...new Set(raw.filter(id => typeof id === 'string' && SLOT_ID_RE.test(id)))];
  const notes = typeof parsed?.notes === 'string' ? parsed.notes.trim() : '';
  return { reroll, notes };
}
