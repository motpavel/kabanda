# Manual QA закрытого preview — 2026-08-28

Проверено:
- роли: гость по приглашению, организатор, участник;
- разделы: magic-link, список Кабанд, карта/список точек, создание рейда, lobby, readiness, приглашение;
- основные сценарии: auth, создание Кабанды, alpha-import, invite/auth/join, одноразовость приглашения, permission denial, mobile layout.

Итог:
- критичных багов: 0
- высоких: 0
- средних: 0
- низких: 1 открытый, 1 исправлен в текущем delivery delta

## Scope и environment

- Environment: закрытый Cloudflare preview `https://comparison-scored-selection-shared.trycloudflare.com`.
- Exact tested deployed build: `9f2c075d877f70b678b0a635c327435aeea83f31`.
- Browser: реальный Chromium 152 через Playwright CLI.
- Viewports: desktop и `390x844`; light theme.
- Roles: unauthenticated invitee, `manual.qa@example.com` organizer, `invitee.qa@example.com` participant.
- Review mode: rendered review.
- Safe data: отдельная QA Кабанда, два QA-рейда и одноразовые QA-приглашения в изолированной preview database.

## Пройденные сценарии

- Magic-link не активируется от открытия: пользователь явно нажимает кнопку входа.
- Создана QA Кабанда; пустое обязательное название не отправляется.
- Exact `import-alpha.js` загрузил 27 `source_checked` точек; карта и список отобразились.
- Создан рейд, открыт lobby, назначен navigator, участник отметил готовность.
- Readiness без location fail-closed с конкретными причинами.
- Readiness со свежей эмулированной координатой 8 м разрешил кнопку старта с честными browser/PWA warnings.
- Start не прошёл без `field_verified` точек; сервер вернул понятный canonical conflict, не false green.
- Organizer создал одноразовое приглашение.
- Guest увидел preview и не вступил автоматически.
- После magic-link пользователь вернулся к приглашению, явно принял его и стал участником.
- Повторное использование invite token отклонено.
- Participant UI не показывает organizer actions; прямой create-raid запрос с валидными safety headers завершился fail-closed без создания объекта.
- На `390x844` горизонтального overflow нет: `scrollWidth === clientWidth === 390`.

## Remediation во время прохода

### OPS-001 [Resolved] На стенде не был загружен alpha point collection

Role: organizer
Location: `/app`, карта и start raid
Environment: Chromium, desktop и mobile
Preconditions: новая изолированная preview database

What I did:
1. Создал Кабанду и рейд.
2. Прошёл lobby/readiness.
3. Попытался начать рейд.

Expected:
Стенд содержит документированный alpha point collection либо явно требует операторский import до рейда.

Actual:
До exact import карта была пустой, а start возвращал «Нет проверенных точек».

Impact:
Preview нельзя было использовать даже для проверки карты и pre-start flow.

Reproducibility:
Always на новой database без import.

Resolution:
В QA Кабанду импортированы 27 source-checked точек exact-built `import-alpha.js`. В deployment runbook добавлен обязательный, идемпотентный import после создания alpha Кабанды. Import не выдаётся за field verification.

### BUG-001 [Resolved] Nested auth route запрашивает относительные иконки

Role: guest
Location: `/auth/verify`
Environment: Chromium, desktop
Preconditions: открыть magic-link route

What I did:
1. Открыл `/auth/verify#token=...`.
2. Проверил console/network.

Expected:
Icon и apple-touch-icon загружаются с canonical root paths.

Actual:
Дважды получен `404 /auth/icon.svg`.

Impact:
Не блокирует auth, но создаёт console noise и неверную иконку на nested routes.

Reproducibility:
Always на deployed build `9f2c075...`.

Resolution:
В том же delivery delta пути сделаны root-relative; public smoke проверяет markup и оба icon assets.

### BUG-002 [Low] MapLibre делает лишний 404 worker-запрос

Role: organizer / participant
Location: карта точек `/app?kabanda=...`
Environment: Chromium 152, desktop и `390x844`, light theme
Preconditions: импортирован alpha collection

What I did:
1. Открыл карту с 27 точками.
2. Проверил network requests и взаимодействие с картой.

Expected:
Все runtime assets карты загружаются без 404.

Actual:
`GET /assets/maplibre-gl-worker.mjs` возвращает 404. Raster tiles, markers, zoom и list fallback остаются рабочими.

Impact:
В текущем raster-only flow пользовательского сбоя не обнаружено; остаётся low console/network noise и residual risk для будущих vector/style функций.

Reproducibility:
Always при первом открытии карты на tested build.

Suggested fix:
Явно настроить bundled worker URL или отключить ненужный external worker lookup; добавить focused browser assertion только если raster map поведение изменится.

## Не проверено и почему

- Реальный start/check-in/photo/offline/finish/result не засчитывался: в manifest нет ни одной честно `field_verified` точки.
- Physical iOS/Safari и Android/Chrome, installed standalone, screen lock, Wake Lock, camera/share, 60–90 минут battery/storage и field ride требуют физических устройств и людей.
- Dark mode не проверялся: отдельного переключателя темы в текущем VP нет.
- Synthetic CI уже покрывает canonical start/route/check-in/photo/finish/history и offline recovery, но не заменяет перечисленные physical gates.

## Вердикт

Desktop closed-preview и invite/auth/join/pre-start flow готовы к показу. Переход к реальному рейду — только после
физической проверки 5–8 точек, записи evidence в manifest и повторного exact import без ручного DB repair.

