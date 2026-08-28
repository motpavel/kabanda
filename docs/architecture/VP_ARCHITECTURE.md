# Архитектура закрытой альфы

Статус: рабочая граница для #32–#38. Цель — быстро проверить продукт на группе до 20 человек без одноразового прототипа и без production-scale инфраструктуры.

## Компоненты

```text
apps/pwa ── same-origin /api ──> apps/api ──> PostgreSQL + PostGIS
    │                                │
    └─ IndexedDB identity ledger     ├─> private S3-compatible storage
                                     └─> transactional email

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
- Медиа приватны; клиент получает только короткоживущие bounded upload/download URL.

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

## Локальная среда

`infra/compose.yaml` поднимает PostGIS, S3-compatible MinIO и Mailpit. Приложения запускаются обычным pnpm workspace. Managed-провайдеры выбираются перед staging без изменения доменных контрактов.
