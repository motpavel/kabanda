# VP acceptance — живой отчёт 2026-08-28

Этот append-only отчёт ведётся для delivery #38 и PR #47. Он не выдаёт браузерную эмуляцию за физическую
приёмку и не разрешает merge/public launch. Decision owner — Павел; текущая фаза — `AUTOMATION/PREP`,
решение — `PENDING`.

## Exact scope

| Поле | Значение | Статус |
|---|---|---|
| Source base | `eee8a18b67d5ce7f9941cfe3fa5a02dc0a5f57e3` | зафиксирован в delivery chain |
| Последний развёрнутый build | `9e66788b054afb3d2c552554e691403223113f27` | Quick Tunnel preview |
| Delivery candidate | exact SHA фиксируется после локального gate и push | Pending |
| Migration | `0008_closed_alpha_access.sql` | локальный Postgres gate |
| Alpha audience | максимум 20 active grants | реализовано fail-closed |
| Alpha points | `27 source_checked`, `0 field_verified` | field start запрещён |
| Preview origin | `https://comparison-scored-selection-shared.trycloudflare.com` | временный demo URL |
| Stable domain / real SMTP | Cloudflare account/domain и authenticated TLS SMTP | Pending external gate |

## Автоматические попытки — append-only

| Попытка | Проверка | Результат | Evidence |
|---:|---|---|---|
| 1 | Предыдущий exact delivery chain #30–#38 | Pass | draft PRs #39–#48, CI и independent exact-head reviews |
| 2 | Closed-alpha access: non-enumeration, revoke, serialized cap 20 | Pass | focused PostgreSQL integration, exact candidate pending |
| 3 | Scoped rollback: exact target, unrelated isolation, immutable result retention, concurrent membership | Pass | focused PostgreSQL integration, exact candidate pending |
| 4 | Media decoder boundary и dependency audit | Pass | malformed/disguised/GIF/TIFF rejection; production audit clean |
| 5 | Install/account switch/MapLibre worker | Pass | PWA unit/build и mobile Chromium smoke; physical devices Pending |
| 6 | Alpha point evidence validator | Pass | 10 validator tests; manifest remains 27/0 |

Exact commands, SHA и CI run добавляются новой строкой после push. Неуспешные попытки не удаляются.

## Что уже можно показывать

- Magic-link, Кабанды, приглашения и роли, карта/list fallback, lifecycle рейда, offline queues,
  check-in/media, результат/history и следующий рейд.
- PWA install guidance; account switch с блокировкой активной записи и предупреждением о pending inventory.
- Закрытая alpha enrollment/revoke и scoped rollback с hard cap 20.

## Незакрытые физические gates

- реальный iPhone/Safari и Android/Chrome в browser/standalone;
- 60–90 минут lifecycle/battery/storage на обоих устройствах;
- полевая проверка 5–8 безопасных точек с restricted evidence;
- внутренний рейд 4–6 человек, offline segment, navigator handoff и deferred SW update;
- пять bounded интервью, repeat ride/retention и финальное GO/LIMITED GO/NO-GO.

Пока `field_verified=0`, реальный start обязан оставаться fail-closed. Тестовый synthetic start не меняет
этот факт.

## Deployment gates

- [ ] exact candidate committed and pushed;
- [ ] GitHub CI green на exact SHA;
- [ ] «Кабанда Разработка» дала exact-head approval;
- [ ] backup/readback/hash создан до migration;
- [ ] preview identities enrolled до production API restart;
- [ ] public smoke и enrolled magic-link login прошли;
- [ ] issue #38 получил sanitized evidence и exact SHA;
- [ ] stable named Tunnel/domain и real SMTP готовы до внешней alpha.

## Решение

`PENDING`: программный контур близок к pre-alpha readiness, но физические device/field/ride gates ещё не
выполнены. Разрешение владельца на preview deployment получено; merge не разрешён.
