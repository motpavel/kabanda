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
| 1440×1000 | нет | виден в phone frame | помещается |

## Interaction smoke

Проверен полный путь:

1. `Новый рейд` открывает dialog.
2. `Выбрать маршрут` открывает routable preview.
3. `Поехать по маршруту` открывает выбор участников.
4. Чекбокс участника меняет состав.
5. `Продолжить` открывает состояние `Рейд собран`.

Также проверяются прямые query-состояния `idle`, `loading`, `catalog-error`, `empty`.

## Automated checks

- `pnpm --filter @kabanda/pwa typecheck`
- `pnpm --filter @kabanda/pwa test`
- `pnpm --filter @kabanda/pwa build`

Новый unit test фиксирует допустимые query states и полноту карточек маршрутов.
