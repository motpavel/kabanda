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

## Локальная среда

`infra/compose.yaml` поднимает PostGIS, S3-compatible MinIO и Mailpit. Приложения запускаются обычным pnpm workspace. Managed-провайдеры выбираются перед staging без изменения доменных контрактов.
