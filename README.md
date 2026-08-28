# КАБАНДА

Репозиторий приложения для совместных городских велорейдов. Код организован как небольшой pnpm workspace:

- `apps/pwa` — устанавливаемый React/Vite клиент;
- `apps/api` — same-origin Fastify API;
- `packages/contracts` — проверяемые DTO;
- `packages/domain` — чистые продуктовые правила;
- `infra` — локальные PostGIS, private object storage и тестовая почта.

Capability-spike для [VP 1/9, issue #30](https://github.com/motpavel/kabanda/issues/30) доступен на `/lab` и измеряет фактическое поведение устанавливаемой PWA. В [issue #32](https://github.com/motpavel/kabanda/issues/32) поверх него собирается минимальный рабочий фундамент закрытой альфы; production shell Кабанды открывается на `/app` и является `start_url` установки.

HTTPS-стенд для физических тестов: [motpavel.github.io/kabanda](https://motpavel.github.io/kabanda/).

Статус решения: ожидаются реальные iPhone/Android и полевая проверка alpha-точек. Эмуляция браузера не считается `GO PWA`.

## Локальный запуск

```bash
cp .env.example .env
pnpm install
pnpm infra:up
pnpm db:migrate
pnpm dev
```

Полная инструкция: [docs/development/LOCAL_SETUP.md](docs/development/LOCAL_SETUP.md). Для service worker, геолокации, камеры и Wake Lock используйте HTTPS или localhost.

## Проверки

```bash
pnpm check
```

## Артефакты #30

- [жизненный цикл рейда](docs/product/raid-lifecycle.md);
- [ADR PWA capability boundary](docs/adr/0001-pwa-capability-boundary.md);
- [физическая device matrix](docs/testing/pwa-device-matrix.md);
- [правила alpha-точек](docs/points/README.md);
- PWA Capability Lab, экспортирующий JSON и GeoJSON evidence.
