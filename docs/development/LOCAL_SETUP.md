# Локальный запуск

Требования: Node.js 22+, pnpm 11.19+, Docker с Compose.

```bash
cp .env.example .env
pnpm install
pnpm infra:up
pnpm db:migrate
pnpm dev
```

- PWA: http://localhost:5173
- API health через PWA proxy: http://localhost:5173/api/health
- Mailpit: http://localhost:8025

Остановка сервисов без удаления данных:

```bash
pnpm infra:down
```

Минимальная проверка перед push:

```bash
pnpm check
```
