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
- PWA не хранит auth token в localStorage/IndexedDB/URL; браузер получает HttpOnly cookie.
- IndexedDB хранит только локальные операции, привязанные к identity, и повторяет их идемпотентно.
- PostGIS используется только там, где нужна серверная проверка расстояния.
- Медиа приватны; клиент получает только короткоживущие bounded upload/download URL.

## Не строим в VP

Микросервисы, Redis, Kubernetes, отдельную очередь, event sourcing, multi-region, универсальный repository framework и большой observability stack.

## Локальная среда

`infra/compose.yaml` поднимает PostGIS, S3-compatible MinIO и Mailpit. Приложения запускаются обычным pnpm workspace. Managed-провайдеры выбираются перед staging без изменения доменных контрактов.
