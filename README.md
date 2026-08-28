# КАБАНДА

Репозиторий приложения для совместных городских велорейдов.

Текущая ветка содержит capability-spike для [VP 1/9, issue #30](https://github.com/motpavel/kabanda/issues/30). Стенд измеряет фактическое поведение устанавливаемой PWA до начала основной разработки.

## Локальный запуск

```bash
pnpm install
pnpm dev
```

Для service worker, геолокации, камеры и Wake Lock используйте HTTPS или localhost.

## Проверки

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm preview
```

## Артефакты #30

- [жизненный цикл рейда](docs/product/raid-lifecycle.md);
- [ADR PWA capability boundary](docs/adr/0001-pwa-capability-boundary.md);
- [физическая device matrix](docs/testing/pwa-device-matrix.md);
- [правила alpha-точек](docs/points/README.md);
- PWA Capability Lab, экспортирующий JSON и GeoJSON evidence.

