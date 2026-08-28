# Архитектура закрытой альфы

Статус: рабочая граница для #32–#38. Цель — быстро проверить продукт на группе до 20 человек без одноразового прототипа и без production-scale инфраструктуры.

## Компоненты

```text
apps/pwa ── same-origin /api ──> apps/api ──> PostgreSQL + PostGIS
    │                                │              └─> private normalized media BYTEA
    └─ IndexedDB identity ledger     └─> transactional email

packages/contracts — проверяемые HTTP DTO
packages/domain    — чистые правила без React/Fastify/PostgreSQL
```

## Почему так

- Один API и одна база проще отлаживать и выкатывать.
- Сервер владеет авторизацией, жизненным циклом рейда, геопроверкой и итогами.
- PWA не хранит session token в localStorage/IndexedDB/URL; браузер получает HttpOnly cookie.
- Одноразовое подтверждение входа приходит во fragment, который не отправляется серверу и сразу удаляется из address bar; GET ничего не потребляет, обмен выполняет явный same-origin POST.
- IndexedDB хранит только локальные операции, привязанные к identity, и повторяет их идемпотентно.
- Logout очищает активную локальную identity: операции не replay-ятся без сессии и для другого пользователя, но сохраняются до повторного входа того же пользователя, чтобы не терять полевые данные.
- PostGIS используется только там, где нужна серверная проверка расстояния.
- Медиа приватны. В закрытой альфе нормализованные изображения хранятся bounded `BYTEA` в PostgreSQL
  за repository boundary и выдаются только через same-origin membership-gated API.

## Не строим в VP

Микросервисы, Redis, Kubernetes, отдельную очередь, event sourcing, multi-region, универсальный repository framework и большой observability stack.

## Граница #33: Кабанды и первая коллекция точек

- Только роли `owner` и `member`. Передача ownership и универсальный RBAC не входят в alpha.
- Создание Кабанды и принятие приглашения требуют idempotency key и выполняются транзакционно.
- Сырой invite приходит во fragment `/invite#invite=…`, немедленно удаляется клиентом и обменивается
  на короткоживущий opaque continuation в `HttpOnly; SameSite=Lax` cookie. Magic-link возвращает на
  base-aware `/invite` без bearer-секрета в URL; standalone получает тот же cookie jar.
- Idempotency key принятия детерминированно выводится из continuation через SHA-256. После потерянного
  ответа reload восстанавливает pending cookie, а сервер возвращает уже принятое membership только тому
  же авторизованному пользователю.
- `APP_ORIGIN` хранит только origin для CSRF-проверки, а `APP_BASE_PATH` (`/` локально,
  `/kabanda/` для Pages) применяется к verification URL в письме и совпадает с Vite `BASE_URL`.
- Авторизация приватных данных всегда строится как `session user -> active membership -> Kabanda`;
  `kabandaId`, `userId` или collection ID из запроса сами по себе не дают доступа.
- API точек требует конкретную коллекцию, ограниченный bbox Ижевска и жёсткий limit. Full dump отсутствует.
- Stable point ID переживает rename/archive. Новые действия для archived point запрещаются, история сохраняет
  snapshot имени и координат.
- Последняя point-проекция IndexedDB ключуется `identity + Kabanda + collection` и при offline всегда
  показывается как stale. Приватный ответ не кладётся в общий Cache Storage.
- Для 27 alpha-кандидатов используется bounded MapLibre-карта с raster OSM и обязательной атрибуцией,
  загружаемая отдельным chunk, плюс полноценный список. Ошибка WebGL/provider
  переключает presentation в список, а не блокирует сценарий.

Пока #30 не даст field verification, manifest остаётся `source_checked`: его можно импортировать и
показывать для разработки, но нельзя объявлять проверенной полевой коллекцией или разрешать обычный чекин.

## Граница #34: рейд и lobby

- Рейд создаётся как серверный `draft`: незавершённая форма переживает reload, а PWA не изображает
  каноническое состояние локальным флагом.
- Состояние меняют только named commands. Каждая критичная команда передаёт `expectedVersion` и
  `Idempotency-Key`; receipt хранит нормализованный fingerprint и неизменяемый bounded snapshot ответа.
  Lost-response replay возвращает этот snapshot, даже если рейд позже перешёл в другое состояние.
- `open-lobby` фиксирует заранее выбранных активных участников Кабанды. UUID рейда — только locator:
  direct-ID read/write всё равно требует активное membership и строку участника; чужой tenant получает 404.
- Единственный активный рейд обеспечивается partial unique constraint для
  `active | paused | finalizing`. Несколько draft/planned/lobby допустимы и никогда не сворачиваются в
  случайный «current»: deep link читает exact raid, home показывает детерминированный actionable list,
  а current endpoint относится только к каноническому активному рейду.
- Старт доступен только online после свежего server-owned readiness report текущего навигатора для
  текущей версии lobby. Report фиксирует режим PWA, location permission, свежесть/точность sample,
  IndexedDB/storage и connectivity. Смена навигатора или версии инвалидирует старый report.
- До физического решения #30 background/lock-screen GPS остаётся `unknown`, а не зелёным обещанием.
  Lobby обновляется при open/focus/online и видимым polling; offline cache read-only и всегда помечен stale.
- В delivery #34 реально достижимы `draft | planned | lobby | active | paused | cancelled`.
  `finalizing | completed` остаются зарезервированной доменной/SQL-основой для #37: #34 не публикует
  преждевременные finalize/complete routes и не изображает готовый результат. Participant leave также
  добавляется вместе с правилами credit/cutoff в последующем полевом срезе, а не как безусловная кнопка.

## Граница #35: активный рейд, recorder и offline replay

Для закрытой альфы до 20 человек маршрут синхронизируется обычными same-origin HTTP-командами и
видимым polling канонической проекции. WebSocket/SSE, Redis, отдельный broker и live-позиции участников
не нужны. Page runtime записывает GPS; service worker может только ускорить replay той же application-owned
очереди и никогда не владеет geolocation, raid state или navigator lease.

### Server lease и fencing

- На рейд существует не более одного активного server-issued route lease. Lease привязан к raid,
  canonical navigator, identity, `clientInstanceId` и монотонной generation/epoch.
- Потеря сети не завершает lease и не передаёт роль автоматически. Конкурирующий tab/device получает
  deterministic conflict; takeover возможен только named recovery или handoff.
- Pause, handoff и recover выполняются fail-closed: сервер под row lock фиксирует собственный cutover,
  закрывает текущую generation и больше не принимает для неё batches. Client `capturedAt`, local clock и
  поздно доставленный outbox не могут расширить lease interval назад или вперёд.
- Resume никогда не переоткрывает старый lease. Даже тот же navigator получает новую generation через
  acquire; старые operation IDs и local sequence остаются fenced в прежней generation.
- Offline replay допустим только для того же actor и всё ещё активного lease той же generation. Если
  другой клиент уже выполнил pause/handoff/recover, сервер возвращает bounded terminal rejection;
  локальная операция остаётся диагностическим evidence/`needs_action`, но не становится canonical route.

### HTTP и DTO contract

- `GET /api/raids/:raidId` добавляет bounded `RaidRouteStatus`: generation, navigator, server ingestion
  health, last accepted sample time/count и server-allowed actions; raw coordinates и `clientInstanceId`
  не выдаются. Local recorder truth остаётся только в PWA runtime.
- `POST /api/raids/:raidId/route/lease/acquire` принимает `RouteLeaseRequest` и возвращает
  `RouteLeaseResponse`. Повтор того же operation возвращает immutable prior response.
- `POST /api/raids/:raidId/route/lease/recover` использует те же DTO, явно fence-ит прежнюю generation
  и создаёт новую только после server authorization.
- `POST /api/raids/:raidId/route/batches` принимает bounded `RouteBatchInput` с `RouteSampleInput[]`
  (не более 50 samples и 64 KiB) и возвращает immutable `RouteBatchReceipt`.
- `POST /api/raids/:raidId/commands/handoff-navigator` принимает `HandoffNavigatorInput`, закрывает
  прежний lease и меняет canonical navigator в одной транзакции. Новый navigator затем acquire-ит
  собственную generation.
- Все mutation requests используют `Idempotency-Key`; повтор с тем же fingerprint возвращает prior
  receipt, а reuse ключа с другим payload получает conflict. Lease/batch writes не доверяют client totals.

### Данные и local durability

- PostgreSQL хранит `raid_route_leases`, `raid_route_batches` и `raid_route_samples`. Unique active-lease
  constraint и `(lease_id, local_seq)` защищают one-recorder и no-duplicate invariants; координаты приватны.
- Dexie хранит identity-bound `recorderSessions`, `routeSamples`, versioned outbox и короткий sender lock.
  Sample сначала durable-записывается в IndexedDB и лишь затем может сделать recorder зелёным.
- Local recorder имеет только runtime states
  `idle | starting | recording | stale | paused | stopped | error`; это не второй raid lifecycle.
  `recording` требует canonical navigator/active lease, живой `watchPosition`, granted permission,
  свежий locally durable sample и отсутствие известного lifecycle/storage failure.
- Без свежего durable sample дольше ADR-порога (предварительно 15 секунд) recorder становится `stale`.
  Permission revoke, IndexedDB failure, incompatible schema и fenced lease не могут оставлять зелёный UI.
- Replay запускается на startup, `pageshow`, foreground/visible, `online` и manual retry. Background Sync
  остаётся optional acceleration. 401 приостанавливает очередь; account switch никогда не меняет actor.
- Service-worker update показывается как deferred и не вызывает принудительный reload во время active
  recorder или несовместимой pending queue.

### Active shell и границы следующих delivery

- Active shell показывает raid/navigator, честный recorder state, online/offline, locally saved/syncing count,
  bounded route preview и не более одного primary action. Local time/distance помечаются `предварительно ·
  на телефоне` и не смешиваются с canonical totals.
- #35 не публикует background/lock-screen GPS promise. Supported navigator mode остаётся experimental до
  физического решения #30/ADR-0001.
- #36 добавляет check-in, canonical eligible/nearest point, media payloads/endpoints и настоящий point
  progress. #35 только готовит versioned outbox boundary и не изображает эти операции выполненными.
- #37 добавляет `finalizing/completed`, канонические distance/time, history и result card. #35 не считает
  live provisional metrics финальным результатом.

Code acceptance #35 покрывает mocked geolocation/lifecycle, PostgreSQL auth/idempotency/fencing, Dexie
reload/replay, account isolation, service-worker update gate и mobile shell. Product/field acceptance остаётся
открытым до отдельного 60–90-минутного physical smoke на реальных iPhone и Android по матрице #30.

## Граница #36: быстрый чекин и приватные фотографии

- При старте рейда сервер атомарно замораживает только `field_verified` точки активной коллекции. Snapshot
  имени и координат неизменяем; последующие правки каталога не меняют уже начатый рейд.
- Nearby возвращает не более пяти snapshot-точек. Обычный чекин принимает независимый one-shot GPS sample
  не старше 60 секунд, с accuracy не хуже 50 м, и сервер сам проверяет радиус 75 м через PostGIS.
- Один actor-wide operation ID с тем же fingerprint всегда возвращает прежний receipt; изменённый payload
  получает conflict. Credit защищён уникальностью `(raid, point snapshot, user)`, evidence append-only.
- Первый offline replay с уже просроченной геолокацией сохраняется как immutable
  `needs_manual_verification/location_expired` и никогда автоматически не начисляет credit.
- Выбор присутствующих создаёт self-claims. Только явная owner organizer attestation может начислить credit
  выбранным участникам без их подтверждения; обычный пользователь подтверждает или отклоняет только себя.
- Manual fallback требует прежний rejected/needs-review attempt, accepted media того же рейда и другого
  активного verifier. До его подтверждения credit не создаётся.
- Media intent живёт 15 минут и проходит сериализованный `pending -> processing -> accepted|failed|expired`.
  Capability хранится только в хешированном виде на сервере и только в памяти клиента; потерянный accepted
  response повторяется идемпотентно.
- Вход ограничен 8 МиБ JPEG/PNG/WebP и 12 MP/8000 px. Sharp декодирует фактические bytes, auto-orient,
  уменьшает до 2048 px и перекодирует JPEG не более 3 МиБ без EXIF; исходник не хранится.
- Галерея ограничена 100 фото на рейд, ответы имеют `private, no-store`, удаление оставляет tombstone.
- Dexie хранит stable `clientDraftId`/SHA и Blob, а sender использует lease/fence/`claimUntil`. Просроченный
  `sending` восстанавливается после crash; capability никогда не попадает в durable storage.
- Просроченный media intent заменяется новым operation ID при том же stable draft/SHA. WebSocket, Redis,
  S3 и native background upload для alpha не требуются.

## Локальная среда

`infra/compose.yaml` поднимает только PostGIS и Mailpit. Для alpha медиа остаются в PostgreSQL, поэтому
отдельное object storage не запускается. Приложения работают как обычный pnpm workspace; managed-провайдеры
выбираются перед staging без изменения доменных контрактов.
