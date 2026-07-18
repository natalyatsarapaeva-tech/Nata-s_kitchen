# Спецификация: схема данных и алгоритм генерации недельного меню

Версия 0.1 — черновик для обсуждения

---

# ЧАСТЬ 1. СХЕМА ДАННЫХ

## 1.1. Сущность Recipe (рецепт)

Поля делятся на три класса по способу заполнения:
- **[user]** — вводит пользователь или приходит из скана
- **[ai]** — размечает LLM при импорте (с полем confidence)
- **[calc]** — считается детерминированно из других полей

```yaml
Recipe:
  # --- Идентичность ---
  id: uuid
  title: string                     # [user/ai]
  source: enum                      # user_scan | user_manual | builtin | web
  source_url: string?               # для web
  lang: string
  photo_urls: [string]
  created_at, updated_at: datetime

  # --- Ингредиенты (структурированные) ---
  ingredients:
    - ingredient_id: uuid           # ссылка на справочник ингредиентов
      raw_text: string              # как было в оригинале ("2 луковицы")
      quantity: float               # [ai] нормализованное количество
      unit: enum                    # g | ml | pcs | tbsp | tsp | pinch
      quantity_confidence: float    # [ai] 0..1
      optional: bool                # [ai] "по желанию"
      role: enum                    # [ai] main | supporting | seasoning | garnish
      substitutes: [ingredient_id]  # [ai] допустимые замены

  # --- Шаги ---
  steps:
    - order: int
      text: string
      duration_min: int?            # [ai]
      is_active: bool               # [ai] требует присутствия у плиты
      equipment: [enum]             # [ai] oven | stovetop | blender | slow_cooker | ...
      can_pause_after: bool         # [ai] можно ли прерваться после шага
                                    # (важно для "готовлю в два захода")

  # --- Время ---
  time:
    active_min: int                 # [calc] сумма активных шагов
    passive_min: int                # [calc]
    total_min: int                  # [calc]
    prep_ahead_possible: bool       # [ai] можно ли подготовить заранее
                                    # (замариновать вечером, доготовить утром)

  # --- Жизненный цикл готового блюда (ключевой блок!) ---
  lifecycle:
    eat_fresh_only: bool            # [ai] салаты, гриль, суши
    fridge_days: int                # [ai] 0..5, сколько живёт в холодильнике
    improves_next_day: bool         # [ai] борщ, рагу, карри, плов
    freezable: bool                 # [ai]
    freezer_months: int?            # [ai]
    freeze_stage: enum?             # [ai] raw | cooked | both
                                    # (котлеты можно морозить сырыми — это
                                    # другой сценарий батч-кукинга)
    reheat_quality: enum            # [ai] excellent | good | acceptable | poor
    reheat_method: [enum]           # [ai] microwave | stovetop | oven
    reheat_time_min: int            # [ai]

  # --- Масштабирование ---
  scaling:
    base_portions: int              # [user/ai]
    easily_scalable: bool           # [ai] суп ×3 — да, стейк ×3 — нет
    max_reasonable_batch: int       # [ai] порций, ограничено размером кастрюли/духовки
    scaling_notes: string?          # [ai] "время запекания не умножать"

  # --- Питание (на 1 порцию) ---
  nutrition:                        # [calc] из справочника ингредиентов,
    kcal: float                     # [ai] fallback если ингредиент не распознан
    protein_g, fat_g, carbs_g: float
    fiber_g: float?
    veg_share: float                # доля овощей по массе, 0..1
    heaviness: enum                 # [ai] light | medium | heavy
    confidence: float

  # --- Экономика ---
  economics:
    cost_estimate: float            # [calc] по ценовому справочнику, валюта из профиля
    cost_tier: enum                 # [calc] budget | mid | premium
    perishable_share: float         # [calc] доля скоропортящихся ингредиентов по стоимости
    pantry_only: bool               # [calc] можно приготовить из базовых запасов

  # --- Классификация ---
  tags:
    meal_type: [enum]               # breakfast | lunch | dinner | snack | dessert
    cuisine: enum                   # [ai]
    main_protein: enum              # [ai] chicken | beef | pork | fish | legumes | eggs | none
    main_carb: enum                 # [ai] pasta | rice | potato | bread | none
    technique: [enum]               # [ai] baking | frying | stewing | boiling | raw | grilling
    festivity: int                  # [ai] 1..5: 1 = будничное, 5 = праздничное
    seasonality: [enum]             # [ai] all | summer | winter | ...
    kid_friendly: bool              # [ai]
    spiciness: int                  # [ai] 0..3
    diet_flags: [enum]              # [ai] vegetarian | vegan | gluten_free | lactose_free | ...
  skill_level: enum                 # [ai] beginner | intermediate | advanced

  # --- Пользовательские сигналы (per user!) ---
  user_signals:
    rating: int?                    # явная оценка
    times_cooked: int
    times_planned: int
    times_skipped: int              # запланировали, но не приготовили — сильный
                                    #   негативный сигнал
    times_substituted: int
    last_cooked_at: date?
    is_favorite: bool
    family_verdicts: {member_id: enum}  # loved | ok | refused
```

### Замечания к разметке [ai]
1. Каждое AI-поле хранит `confidence`. Поля с confidence < порога показываются пользователю на подтверждение при импорте («Это блюдо можно заморозить? Да/Нет») — так база чистится руками пользователей без ощущения работы.
2. Lifecycle и scaling — самые ценные и самые «человеческие» поля. Для builtin-базы их стоит разметить редакторски, для пользовательских рецептов — LLM + подтверждение.
3. Nutrition считать из справочника ингредиентов, а не спрашивать LLM напрямую — LLM «на глаз» ошибается на 30–50%. LLM нужен только для маппинга «2 луковицы» → ingredient_id + граммы.

## 1.2. Справочник Ingredient

```yaml
Ingredient:
  id: uuid
  names: {lang: [string]}           # синонимы: "томат", "помидор"
  category: enum                    # vegetable | meat | dairy | grain | spice | ...
  nutrition_per_100g: {kcal, protein, fat, carbs, fiber}
  perishability: enum               # days_2 | days_5 | weeks_2 | months | non_perishable
  typical_package: {size: float, unit: enum}   # кинза продаётся пучком —
                                    #   важно для цепочек остатков
  price_per_unit: float?            # из ценовой базы, если подключена
  is_pantry_staple: bool            # соль, масло, мука — не попадают в список покупок
                                    #   по умолчанию
  storage: enum                     # fridge | freezer | pantry
```

## 1.3. Профиль пользователя / домохозяйства

```yaml
Household:
  id: uuid
  members:
    - member_id: uuid
      name: string
      portion_coefficient: float    # взрослый = 1.0, ребёнок = 0.5–0.7,
                                    #   спортсмен на массе = 1.3
      allergies: [ingredient_id]    # ЖЁСТКОЕ ограничение, никогда не нарушается
      dislikes: [ingredient_id | tag]   # мягкое: штраф в скоринге, не запрет
      diet: [enum]?                 # vegetarian | halal | gluten_free | ...
      nutrition_targets: {kcal?, protein_g?, ...}?   # опционально, per member

  goal_preset: enum                 # balanced | weight_loss | muscle_gain |
                                    # budget | minimal_effort | custom
  # Пресет разворачивается в конкретные веса скоринга (см. 2.7)

  weekly_rhythm:                    # ЯДРО персонализации
    - day: enum                     # mon..sun
      dinner_time_budget_min: int   # сколько есть времени на готовку ужина
      lunch_mode: enum              # cook | leftovers | out | skip
      batch_day: bool               # есть время готовить впрок
      note: string?                 # "тренировка до 20:00"

  repeat_tolerance: int             # 1..5: 1 = каждый день новое,
                                    #   5 = могу есть одно и то же 3 дня
  exploration_ratio: float          # 0..1: доля новых (не своих) рецептов в плане
  weekly_budget: float?
  equipment: [enum]                 # что есть на кухне
  cook_skill: enum
  shopping_days: [enum]             # когда закупка — от этого зависит,
                                    #   в какие дни ставить скоропорт
  planned_meals: [enum]             # какие приёмы пищи планируем
                                    #   (только ужины / ужины+обеды / всё)
```

## 1.4. Инвентарь

```yaml
Inventory:
  freezer:
    - recipe_id: uuid
      portions: int
      frozen_at: date
      expires_at: date              # [calc] frozen_at + freezer_months
  fridge_leftovers:
    - recipe_id: uuid
      portions: int
      cooked_at: date
      eat_by: date                  # [calc]
  open_perishables:                 # начатые упаковки — топливо для цепочек
    - ingredient_id: uuid
      remaining: float
      use_by: date
```

## 1.5. План недели (выход алгоритма)

```yaml
WeekPlan:
  week_start: date
  days:
    - date: date
      meals:
        - meal_type: enum
          slot_kind: enum           # cook_fresh | cook_batch | reheat_fridge |
                                    # defrost_freezer | leftover_chain | eat_out
          recipe_id: uuid?
          portions_to_cook: int?    # для cook_batch > porций к съедению
          portions_to_eat: int
          portions_to_fridge: int
          portions_to_freeze: int
          linked_slot: ref?         # связь: этот слот ест то, что готовилось там
          explanation: string       # человекочитаемое "почему это здесь"
  shopping_list: [...]              # см. 2.9
  week_totals: {kcal_avg, cost, active_cooking_min, new_recipes: int}
```

---

# ЧАСТЬ 2. АЛГОРИТМ ГЕНЕРАЦИИ НЕДЕЛИ

Архитектура: **детерминированный планировщик с ограничениями** делает скелет,
**LLM** работает на входе (разметка рецептов) и на выходе (реранк спорных мест,
объяснения, обработка свободных пожеланий вида «хочу на этой неделе больше рыбы»).
LLM не решает, сколько порций заморозить — это считает код.

## 2.0. Вход

```
INPUT:
  household        — профиль (1.3)
  inventory        — инвентарь (1.4)
  recipe_db        — рецепты пользователя + builtin + web-кандидаты
  history          — планы прошлых N недель (для анти-повторов)
  free_text_wish?  — необязательное пожелание текстом
```

Если есть `free_text_wish` → LLM переводит его в структурные модификаторы:
«хочу больше рыбы» → `boost(main_protein=fish, +0.3)`;
«на этой неделе нет времени вообще» → `override(all days: time_budget=20)`.

## 2.1. Шаг 1 — Типизация слотов

```
for each day in week:
    for each meal in household.planned_meals:
        slot = new Slot(day, meal)
        rhythm = household.weekly_rhythm[day]

        if rhythm.batch_day and meal == dinner:
            slot.kind_candidates = [cook_batch, cook_fresh]
        elif rhythm.dinner_time_budget < 25:
            slot.kind_candidates = [reheat_fridge, defrost_freezer,
                                    cook_fresh(quick_only=true)]
        else:
            slot.kind_candidates = [cook_fresh, reheat_fridge, leftover_chain]

        # обеды по умолчанию — доедание, если lunch_mode == leftovers
        if meal == lunch and rhythm.lunch_mode == leftovers:
            slot.kind_candidates = [reheat_fridge, defrost_freezer]
```

Результат: сетка слотов, у каждого — допустимые виды и бюджет времени.

## 2.2. Шаг 2 — Обязательные размещения (инвентарь)

Сначала пристраиваем то, что уже есть — это жёсткий приоритет,
иначе морозилка превращается в кладбище.

```
# 2.2.1 Остатки в холодильнике: срок горит
for item in inventory.fridge_leftovers ordered by eat_by asc:
    slot = earliest slot where reheat_fridge allowed
           and slot.date <= item.eat_by
    if slot: assign(slot, item); lock(slot)
    else: notify_user("Остатки X пропадут — съесть вне плана?")

# 2.2.2 Морозилка: 1–2 разморозки в неделю в самые загруженные дни
frozen = inventory.freezer ordered by expires_at asc
busiest_days = days sorted by dinner_time_budget asc
for i in 0..min(2, len(frozen)):
    assign(busiest_days[i].dinner, frozen[i]); lock(slot)

# 2.2.3 Открытые скоропортящиеся ингредиенты
for ing in inventory.open_perishables:
    add constraint: week must include >=1 recipe using ing
                    before ing.use_by  (мягкое ограничение, вес высокий)
```

## 2.3. Шаг 3 — Пул кандидатов

```
pool = []

# Свои рецепты
for r in user_recipes:
    if violates any allergy of any member: skip     # жёсткий фильтр
    if r.last_cooked_at > today - cooldown(repeat_tolerance): skip
    #   cooldown: tolerance=1 → 21 день, tolerance=5 → 4 дня
    pool.add(r, origin=own)

# Builtin / web — добираем до разнообразия
need_new = ceil(total_dinner_slots * household.exploration_ratio)
candidates = builtin_db.search(
    filters = allergies, diet_flags, equipment, skill_level,
    prefer  = cuisines and proteins близкие к любимым пользователя,
              seasonality == current
)
pool.add(top(candidates, need_new * 3), origin=new)   # ×3 — запас для солвера
```

Мягкие сигналы (dislikes, «ребёнок отказался в прошлый раз») — не фильтр,
а штраф в скоринге.

## 2.4. Шаг 4 — Якоря (батч-блюда)

```
for each batch_slot (из шага 2.1):
    batch_candidates = pool.filter(
        easily_scalable == true,
        freezable == true OR fridge_days >= 2,
        reheat_quality in [excellent, good],
        active_min <= slot.time_budget
    ).rank_by(score)                                  # score — см. 2.7

    best = batch_candidates.top()
    total_household_portions = sum(member.portion_coefficient)

    # Решение о размере партии:
    reheat_slots_open = count(slots with kind reheat_fridge, unassigned,
                              within best.fridge_days of batch_slot.date)
    portions_eat_now   = total_household_portions
    portions_to_fridge = min(reheat_slots_open, 1..2) * total_household_portions
    portions_to_freeze = 0
    if best.freezable and freezer_has_space:
        portions_to_freeze = total_household_portions   # +1 закладка в морозилку

    batch_size = portions_eat_now + portions_to_fridge + portions_to_freeze
    batch_size = min(batch_size, best.max_reasonable_batch)

    assign(batch_slot, best, cook=batch_size)
    for each planned reheat: assign(nearest reheat slot, best,
                                    linked_slot=batch_slot)
```

Развилка: если блюдо `improves_next_day` — предпочесть постановку разогрева
на следующий же день (борщ во вторник вкуснее, чем в четверг).

## 2.5. Шаг 5 — Цепочки остатков

```
for each assigned recipe R с «остаточным потенциалом»
    (R.tags.main_protein in [chicken, beef] and R.technique == baking, и т.п.):
    chain_candidates = pool.filter(uses leftover of R)   # разметка [ai]:
                       # "суп из запечённой курицы", "фриттата из овощей"
    if chain_candidate fits slot on day+1:
        assign with linked_slot=R.slot
        explanation = "Используем оставшуюся курицу с воскресенья"

# Цепочки по ингредиентам:
for each perishable ingredient I, купленный частично
    (recipe uses 0.5 пучка кинзы, package = 1 пучок):
    prefer second recipe using I within perishability window
    (мягкое ограничение, вес средний)
```

## 2.6. Шаг 6 — Заполнение свежим/быстрым

```
for each unassigned slot ordered by date:
    c = pool.filter(
        active_min + passive_min подходят под slot.time_budget,
        eat_fresh_only allowed here (свежее — в первые 2–3 дня
            после household.shopping_days),
        meal_type matches
    )
    assign(slot, argmax(score(c, slot, current_week_state)))
    update current_week_state
```

Порядок заполнения — по дате, потому что скоринг зависит от уже поставленных
блюд (анти-повторы, недельный баланс).

## 2.7. Скоринг

```
score(recipe, slot, week_state) =
    w1 * preference        # rating, times_cooked, is_favorite;
                           #   штраф за times_skipped и family refused
  + w2 * time_fit          # насколько active_min вписывается в бюджет слота
  + w3 * variety           # штрафы: тот же main_protein вчера (-0.4),
                           #   та же cuisine 2 дня подряд (-0.3),
                           #   та же technique 3 дня подряд (-0.2),
                           #   было в плане за последние cooldown дней (-0.5)
  + w4 * nutrition_fit     # вклад в недельные цели: если неделя отстаёт
                           #   по белку — буст высокобелковых
  + w5 * cost_fit          # вписывание в остаток недельного бюджета
  + w6 * ingredient_synergy  # делит скоропорт с уже поставленными блюдами
  + w7 * freshness_window  # скоропорт ближе к дню закупки
  + w8 * exploration_bonus # если origin=new и доля новых ниже целевой
  + w9 * seasonality_and_festivity  # будничное в будни; festivity>=4
                           #   только по запросу/в выходной

goal_preset задаёт веса:
  minimal_effort: w2=0.35, w1=0.25, остальное поровну
  weight_loss:    w4=0.35, приоритет light/medium heaviness
  budget:         w5=0.30, w6=0.15
  balanced:       равномерно, w1 и w3 чуть выше
```

## 2.8. Шаг 7 — Валидация недели и ремонт

```
checks:
  A. avg_daily_kcal в пределах target ±10%        (если цель задана)
  B. protein_weekly >= target                      (если задан)
  C. sum(cost) <= weekly_budget * 1.05
  D. sum(active_min per day) <= day budget         # жёсткое
  E. max same main_protein <= f(repeat_tolerance)
  F. veg_share недели >= 0.25                      # мягкое
  G. все fridge_leftovers пристроены до eat_by
  H. новых рецептов не больше exploration_ratio + 1  # не перегружать новизной

repair loop (max 5 итераций):
    violations = run(checks)
    if none: break
    worst = наиболее нарушенное мягкое ограничение
    swap: найти незалоченный слот, вносящий наибольший вклад в нарушение,
          заменить на следующего кандидата из пула с лучшим вкладом
    if жёсткое ограничение не чинится свапами:
          relax exploration_ratio → retry
          else: показать пользователю конфликт честно
                ("бюджет и белковая цель несовместимы на этой неделе")
```

## 2.9. Шаг 8 — LLM-проход (реранк и человечность)

Вход: готовый скелет плана + профиль + история.
Задачи LLM (строго ограниченные):
1. Проверить «человечность»: нет ли нелепых сочетаний (три супа подряд,
   паста на обед и на ужин одного дня) — вернуть список swap-предложений,
   солвер валидирует их против жёстких ограничений и применяет допустимые.
2. Сгенерировать `explanation` для каждого слота
   («Рагу на 8 порций: ужин сегодня и завтра, 2 порции — в морозилку»).
3. Обработать `free_text_wish`, если он не разложился в модификаторы на входе.

LLM не может: менять порции, нарушать аллергии, трогать залоченные слоты.

## 2.10. Шаг 9 — Список покупок

```
needed = sum(ingredients × portions) по всем слотам с готовкой
minus inventory (pantry_staples, open_perishables)
округлить вверх до typical_package
группировать по категориям магазина
пометить: [для воскресного батча], [купить свежим в четверг]
    — если shopping_days > 1, разбить список по закупкам
опционально: прогнать через ценовую базу → оценка стоимости, подсветка акций
```

## 2.11. Обратная связь (после недели)

```
for each slot:
    cooked      → times_cooked++, спросить рейтинг (ненавязчиво, 1 тап)
    skipped     → times_skipped++; если skip 2 раза подряд — понизить
                  is_favorite; спросить причину одним тапом
                  (не успел / не захотелось / не было продуктов)
    substituted → записать замену; 3 одинаковые замены → предложить правило

Раз в месяц: пересчёт cooldown и exploration_ratio по фактическому поведению
(пользователь декларирует «хочу новое», но готовит одно и то же →
мягко снизить exploration, не спорить с реальностью).
```

---

# Приоритет реализации (MVP → полная версия)

1. **MVP:** схема Recipe (lifecycle + time + scaling обязательно), шаги 2.1,
   2.3, 2.6, 2.7 (упрощённый скоринг), список покупок. Без инвентаря и цепочек.
2. **V2:** инвентарь морозилки/остатков (2.2), батч-якоря (2.4), repair loop.
3. **V3:** цепочки остатков (2.5), LLM-реранк (2.9), обучение на фидбеке (2.11),
   интеграция ценовой базы.

Батч-логика (V2) — главный дифференциатор: «приготовь один раз — поешь три» —
это то, чего нет у конкурентов в юзабельном виде.
