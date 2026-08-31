# Evidence — прототип «Рейды» (#53)

## Прототип

- Route: `/prototype/raids`
- Review controls: `/prototype/raids?review=1`
- Исходник: `apps/pwa/src/features/raids-design/RaidsDesignPrototype.tsx`
- Стили: `apps/pwa/src/features/raids-design/raids-design.css`

## Visual parity

Выполнено четыре последовательных визуальных прохода при логическом viewport 430×900. После четвёртого прохода:

- active card: top 114 px, height 229 px;
- upcoming list: top 383 px, height 114 px;
- route rail: top 537 px, height 184 px;
- history: top 735 px, height 124 px;
- reference active card: примерно top 115 px, height 227 px;
- horizontal page overflow: отсутствует.

Артефакты:

- `docs/design/evidence/raids-final-reference-size.png` — финальный clean frame в размере референса;
- `docs/design/evidence/raids-overlay.png` — полупрозрачное наложение;
- `docs/design/evidence/raids-diff.png` — pixel difference;
- `docs/design/evidence/raids-participants-430x900.png` — экран выбора участников.
- `docs/design/evidence/raids-state-active-390x844.png` — активный рейд;
- `docs/design/evidence/raids-state-idle-390x844.png` — компактное отсутствие активного рейда;
- `docs/design/evidence/raids-state-loading-390x844.png`, `raids-state-empty-390x844.png` и `raids-state-upcoming-empty-390x844.png` — skeleton и empty;
- `docs/design/evidence/raids-state-catalog-error-390x844.png` — изолированная ошибка каталога;
- `docs/design/evidence/raids-state-offline-390x844.png` и `raids-state-fallback-390x844.png` — stale и отсутствующая обложка;
- `docs/design/evidence/raids-upcoming-cases-390x844.png` — длинное имя, отсутствие подтверждений и доступный старт;
- `docs/design/evidence/raids-sheet-new-390x844.png` — chooser;
- `docs/design/evidence/raids-preview-390x844.png`, `raids-preview-archived-390x844.png`, `raids-preview-partial-390x844.png` и `raids-preview-fallback-390x844.png` — normal/archived/partial/fallback preview;
- `docs/design/evidence/raids-schedule-390x844.png` — планирование;
- `docs/design/evidence/raids-participants-long-390x844.png`, `raids-participants-error-390x844.png` и `raids-participants-permission-390x844.png` — 20 человек, retry и permission error;
- `docs/design/evidence/raids-result-lobby-390x844.png` и `raids-result-scheduled-390x844.png` — результаты быстрого старта и планирования;
- `docs/design/evidence/raids-text-120-390x844.png` — smoke увеличенного текста;
- `docs/design/evidence/raids-desktop-1440x900.png` — адаптивный desktop.

Промежуточные изображения после итераций не хранятся в репозитории; в handoff оставлены только итоговые и проверочные кадры.

Большая зона diff сверху ожидаема: референс содержит нарисованную системную строку iOS, а HTML-прототип намеренно её не дублирует. Изображения также отличаются, потому что используются локальные материалы Кабанды.

## Responsive smoke

Проверены viewport:

| Viewport | Горизонтальный overflow | Bottom tabbar | New raid CTA |
| --- | --- | --- | --- |
| 320×568 | нет | виден | помещается |
| 375×667 | нет | виден | помещается |
| 390×844 | нет | виден | помещается |
| 430×900 | нет | виден | помещается |
| 1440×900 | нет | виден в широком app shell | помещается |

Отдельно проверен `text=120` на 390×844: горизонтального overflow нет, sticky CTA и tab bar не перекрываются. Safe-area применяется через `env(safe-area-inset-bottom)`.

## Interaction smoke

Проверен полный путь:

1. `Новый рейд` открывает dialog.
2. `Поехали сейчас` открывает подтверждение состава без global tab bar.
3. `Запланировать` открывает дату/время и затем тот же компонент состава.
4. карточка маршрута открывает routable preview; выбранный маршрут переживает reload и Back/Forward.
5. `Поехать по маршруту` открывает выбор участников.
6. disabled-участник недоступен, выбор сохраняется после server error, повторная отправка защищена состоянием submitting.
7. быстрый старт заканчивается открытым lobby, планирование — состоянием `Рейд запланирован`.

Также проверены прямые query-состояния `idle`, `loading`, `catalog-error`, `partial-error`, `empty`, `upcoming-empty`, `upcoming-cases`, `offline`, `fallback`, `archived`, participant `long/error/permission-error`.

Keyboard smoke: focus trap цикличен, Escape закрывает chooser, фокус возвращается на `Новый рейд`.

## Automated checks

- `pnpm --filter @kabanda/pwa typecheck`
- `pnpm --filter @kabanda/pwa test`
- `pnpm --filter @kabanda/pwa build`

Unit tests фиксируют допустимые query states, полноту карточек маршрутов, 20 участников и disabled member. После объединения с актуальной картой последний PWA-прогон: 32 файла, 111 тестов — passed. Полный `pnpm check` также включает domain, API, stand и data-validation тесты.

Все финальные `*-390x844.png` имеют фактический размер 390×844 и PNG-кодирование; desktop evidence — 1440×900 PNG.

## Остался пользовательский acceptance

Технический browser smoke не заменяет требуемый карточкой физический smoke. После публикации Павлу нужно открыть прототип на телефоне, пройти chooser → состав и оставить в #53 `UX approved` либо конкретный список правок.
