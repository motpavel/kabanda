# Передача Codex: этапы 1–5 Кабанды

## Решение и границы

Это комплект подготовки и передачи, НЕ новый релиз приложения и НЕ разрешение на публикацию.
Не продолжать разработку, не собирать PR вручную, не брать произвольный latest.
Публиковать только после отдельного разрешения владельца на обновление указанного окружения.
Никаких merge/force-push, новых секретов, миграций, bootstrap/restore/enroll, перезапуска общего Relay,
изменений bucket ACL/CORS/lifecycle, `down -v`, prune и очистки IndexedDB/очередей.

**Приложение:** `4c17cce595167f98a21ab6b56e57b57ffe4badf7`, tree `1c991fe91ca62c72a727aebd6e533259df4c1551`.
Цепочка: #63 → #64 → #65 → #66 → #69. #67 и #68 не использовать как релизные кандидаты.
**CI приложения:** https://github.com/motpavel/kabanda/actions/runs/35365776986
verify/postgres/e2e PASS; 433 PWA, 101 API, 81 PostgreSQL, 42 E2E + 4 повторных consistency.
Код этих этапов не изменяется комплектом передачи. SHA комплекта отличается от SHA приложения намеренно.

## Что подтверждено и что надо снять с сервера

В `infra/yandex/runtime-launch-plan.md` зафиксирована выполненная 10 сентября 2026 миграция на
https://kabanda.website.yandexcloud.net/app: API в Compose project `kabanda`, PWA в bucket `kabanda`.
Это документированная конфигурация, НЕ новое обследование сервера 18 сентября.
Старый `docs/deployment/CLOUDFLARE_PREVIEW.md` для этого обновления не выполнять.

На целевой уже разрешённой VM определить текущие image ID, API_BUILD_ID, Compose-файлы и настройки сборки.
Скрипт `inspect` снимает большую часть этих сведений автоматически, только чтением.
Не переключать Docker context/SSH host автоматически. При расхождении с Яндекс-схемой остановиться,
а не переносить приложение в другое окружение. Не останавливать рейд ради выкладки.

Нужно сохранить существующие ПЯТЬ **публичных** настроек frontend в private JSON вне репозитория:

| Поле | Откуда взять |
| --- | --- |
| `VITE_YANDEX_MAPS_API_KEY` | Существующий browser/referer-restricted ключ текущей сборки |
| `VITE_RELAY_BOOTSTRAP_URL` | Существующий URL `…/transport/v1/apps/kabanda/bootstrap.json` |
| `VITE_RELAY_PUBLIC_KEY` | Тот же SPKI PUBLIC PEM, не private key |
| `VITE_RELAY_BLOB_BUCKET` | Текущее значение frontend/private blob bucket |
| `VITE_DIRECT_RELAY_URL` | Тот же direct endpoint; пустая строка только если он уже отключён |

Найти действующий build config в рабочем контексте Codex/на VM. Извлечь только эти поля, не печатать
полный `.env` и не переносить API-конфигурацию в Git. Скрипт отклонит лишние поля, включая секреты.
Ничего не генерировать и не менять значения ради прохождения проверки. Новый
Relay public key сделает существующие сессии/запросы неработоспособными. JSON остаётся на сервере.

## Минимальный путь: подготовка, обследование, готовые команды

Использовать отдельный checkout комплекта, НЕ переключать рабочую ветку Codex с незавершёнными изменениями.
Все аргументы путей ниже выбираются из уже существующего операторского контекста; это не новые конфиги.
`REPO` должен содержать всю историю исходной ветки, не shallow clone. При необходимости загрузить
`chatgpt/product-polish-stage5-final` обычным fetch, без merge/reset/clean.

```sh
KIT=/absolute/path/to/handoff-checkout
REPO=/absolute/path/to/existing/kabanda-checkout
PUBLIC_CONFIG=/absolute/private/path/to/existing-public-build.json
CANDIDATE=/absolute/new/path/kabanda-stages-1-5
COMPOSE_ENV=/etc/kabanda/compose.env
PREFLIGHT=/absolute/new/private/path/preflight.json
COMMANDS=/absolute/new/private/path/commands
```

Сначала сверить исходники и точный CI. Это только чтение Git/GitHub:

```sh
python3 "$KIT/infra/release/stages_1_5.py" verify --repo "$REPO" --github
```

Проверить Node 22, pnpm 11.19.0, Python 3, git, gh и существующий Docker. Ничего автоматически не
устанавливать или обновлять на VM. Для Python-публикатора нужен уже используемый runtime с boto3.
Не запускать от root сборку недоверенных веток. Выполнить подготовку в новом приватном каталоге:

```sh
python3 "$KIT/infra/release/stages_1_5.py" prepare \
  --repo "$REPO" --output "$CANDIDATE" --public-config "$PUBLIC_CONFIG" \
  --node-image 'node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5'
```

Digest взят из зафиксированного успешного Linux build в `infra/yandex/README.container.md`,
а не из предположения о сегодняшнем `latest`. При отдельном согласованном другом digest передать его явно.
Скрипт не запустит контейнер. Создаёт чистый source checkout exact SHA, устанавливает frozen-зависимости,
собирает frontend для `/` с исходными публичными настройками и API image для Linux/amd64.
Выполняет существующий static-publisher dry-run без облачных запросов. Секреты API и NODE_OPTIONS
не наследуются сборкой. Готовый image tag не перезаписывается. При сбое каталог сохраняется для анализа,
но отсутствие `candidate.json` означает НЕГОТОВЫЙ кандидат. Наличие файла само по себе не заменяет
успешную проверку `inspect`. Никакого автоматического удаления.

Выход: `source/`, `candidate.json` с hash каждого PWA-файла и image ID, `public-build.json`,
`api.override.json`. Последний меняет только image, API_BUILD_ID и EXPECTED_MIGRATION в будущем запуске;
существующие `api.env` и `compose.env` не редактируются.

На целевой VM с правом чтения существующей приватной конфигурации:

```sh
python3 "$KIT/infra/release/stages_1_5.py" inspect \
  --candidate "$CANDIDATE" --compose-env "$COMPOSE_ENV" --report "$PREFLIGHT"
```

Проверяются image/build hashes, текущий API и его readiness, SQL в транзакции READ ONLY,
точный список миграций, отсутствие active/paused/finalizing рейдов, совпадение frontend/Relay SPKI,
blob bucket, origin, loopback/database/production guards, volume `kabanda_postgres_data`,
текущие Compose-файлы и image для отката. SHA текущего API должен быть предком кандидата:
неизвестные или более новые серверные изменения не затираются. Секреты не выводятся.

Миграции 0001–0019 уже присутствуют в исходной базе всех пяти этапов. При несовпадении БД скрипт
остановится. Не копировать `EXPECTED_MIGRATION=0018...` из старого stand env example и не запускать
migrate для исправления этой проверки. Нужен отдельный разбор, а не миграция наугад.

Получить ГОТОВЫЕ команды с конкретными путями и образом отката:

```sh
python3 "$KIT/infra/release/stages_1_5.py" render \
  --candidate "$CANDIDATE" --preflight "$PREFLIGHT" \
  --credentials /etc/whitelist-relay/credentials.json \
  --ownership-proof /etc/kabanda/storage-console-ownership.json --output "$COMMANDS"
```

Использовать эти credential paths только если это действующие согласованные файлы текущего deployment.
При наличии отдельного Kabanda publisher credential передать его вместо shared файла.
Консольный ownership-proof должен быть реально перепроверен уполномоченным оператором менее суток назад.
Нельзя просто поменять verifiedAt или сгенерировать доказательство. Пакет его не создаёт.
Существующий publisher дополнительно проверяет credential binding, ownership, ACL и чтение объектов.
Если текущая выкладка использует account-baseline/owner-ID вместо public-flags режима, НЕ менять модель
доступа ради пакета: использовать соответствующий уже проверенный режим из `infra/yandex/README.md`.

`render` повторяет live inspection и сравнивает preimages, создаёт `COMMANDS.md`, `commands.json`
и `api.rollback.json`. Это ТОЛЬКО ЗАПИСЬ КОМАНД, ни одна из них не выполняется автоматически.
Сгенерированный файл заменяет ручной подбор Compose-файлов и image/build ID.

## Публикация после отдельного разрешения владельца

Перед выполнением команд сохранить предыдущий **собранный** frontend/dist и его полный SHA,
предыдущий API image ID и private preflight. Не удалять старый image. Проверить достаточно места
для нового image и private snapshot. Выполняет один оператор, без параллельной выкладки/новых рейдов.
Read-only preflight не блокирует создание новых рейдов: окно обновления согласуется отдельно.

Порядок из `COMMANDS.md`: `recheck`, `validateCompose`, `activateApiOnly`, `probeApiAndRelay`,
и только после PASS `publishStaticAfterApiPass`, затем `smokeStatic`. Проверить, что recheck совпадает с исходным preflight
по container IDs, composeHashes, composeEnvSha256, previousBuild/imageId. Если нет, не выполнять
старые команды: повторно inspect/render и разобраться, кто изменил окружение.
Перед запуском отдельно подтвердить неизменность существующих API env/secret files: snapshot конфигурации
не является блокировкой от параллельных изменений на сервере. Не печатать их содержимое.

API переключается `up -d --no-deps --no-build --pull never --wait ... api` с overlay.
Не трогаются postgres, Mailpit, volumes, секреты, firewall, DNS, bootstrap и общий storage-relay.
Compose override сохранить как часть действующего набора deployment: следующий запуск только
base compose без overlay может вернуть старый build/image из неизменённого compose.env.

Публикатор сохраняет private snapshot, загружает immutable assets перед HTML/SW, проверяет readback;
при собственной ошибке пытается вернуть mutable-объекты. Это не атомарная транзакция всего S3.
При сообщении `rollback incomplete` остановиться и сверить защищённый snapshot; не повторять вслепую.

## Проверка после публикации

1. В `probeApiAndRelay` должны быть `apiReady=true`, `encryptedRelayRoundTrip=true`,
   `apiBuild=4c17cce595167f98a21ab6b56e57b57ffe4badf7`, прежний SPKI fingerprint.
2. Команда `smokeStatic` сравнивает опубликованные байты с hash локальной сборки и HTTP cache headers.
   На `https://kabanda.website.yandexcloud.net/app` дополнительно проверить main manifest, JavaScript, `sw.js`,
   `sw-build-4c17cce59516.js`, root `/app` и `/lab/index.html`. HTML/manifest/SW не кешируются HTTP,
   hashed assets immutable. Запрос `/api/ready` к website origin НЕ проверяет API: backend за Relay.
   Старый `infra/stand/smoke.mjs` предназначен для same-origin стенда, не для этого Storage сайта.
3. В существующем аккаунте без очистки данных проверить вход, Главная/Рейды, всю историю/Мои,
   личные/командные посещения, возврат/камеру, завершённый результат и карточку для друзей.
4. Проверить `/api/kabandas/<id>/raids/history/page` и `/points/progress` через штатный
   авторизованный транспорт, не создавать временные API routes/токены. Не печатать session/capability.
5. Установленная PWA может продолжать старую сборку до обычного подтверждения обновления.
   Не force-reload активного навигатора; сначала сохранить/синхронизировать запись штатным способом.
   Не удалять IndexedDB, offline data или Service Worker как способ «починить обновление».

## Откат

`rollbackApiOnly` возвращает предыдущий image/build с той же схемой. Перед ним сверить, что текущий
контейнер действительно относится к этому кандидату и предыдущий tag всё ещё указывает на сохранённый
image ID. Конкурентный более новый релиз не откатывать. Команда не возвращает frontend автоматически.

Если новый frontend ещё не опубликован: вернуть API, повторить прежний local probe, остановиться.
Если frontend уже опубликован: сначала штатным publisher вернуть сохранённый предыдущий dist с его SHA
(с теми же проверками/доказательством ownership и отдельным новым snapshot), затем вернуть API.
Не оставлять новый frontend на старом API: новые методы чтения истории/посещений могут отсутствовать.
Не восстанавливать БД из dump.
Не использовать `alpha-rollback.js`: это отзыв доступов/архивация alpha-команды, не rollback релиза.

## Отчёт владельцу

Сообщить приложение SHA, kit SHA, предыдущий и новый image ID, фактический URL,
PASS/FAIL локального API/Relay и сайта/PWA, путь protected snapshot без его содержимого,
статус пользовательских проверок, отсутствие миграций/изменений секретов и состояние очередей.
Автотесты пройдены, но ручная приёмка на физических iPhone/Android не объявляется проведённой.

## Проверка самого комплекта

```sh
python3 -m unittest discover -s infra/release -p 'test_*.py' -v
python3 -m unittest discover -s infra/yandex -p 'test_*.py' -v
node --test infra/stand/*.test.mjs
```

`infra/stand/release-handoff.test.mjs` включает обе Python-группы в существующий `pnpm test:stand`,
поэтому штатный CI проверяет и новый комплект, и прежние Yandex deploy helpers без изменения workflow.
Тесты используют temporary files, synthetic data и mocks. Они НЕ запускают production build/deploy,
Docker services, облачную публикацию или запросы к рабочей БД. Сборку с реальными публичными
настройками и осмотр VM выполняет Codex по командам выше, а не этот чат.
