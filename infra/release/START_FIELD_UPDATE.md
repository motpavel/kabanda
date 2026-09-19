# Обновление Кабанды: единая инструкция Codex

## Сначала прочитать

Приложение и инструменты находятся в PR #74, ветка `chatgpt/field-stabilization`.
**Разрешение на подготовку не является разрешением на публикацию.** До отдельного решения Павла
выполнить только чтение/сборку и выдать результат. Не merge draft PR, не force-push, не переключать
рабочую папку с незавершёнными изменениями, не менять секреты, ACL, DNS, firewall или общий Relay.

Источник версии: exact SHA и CI run из итоговой подтверждённой передачи/описания PR #74.
Не брать произвольный latest, прежний #73 или пакет #70. При несовпадении остановиться.
`prepare_field_release.py` отвергает красный CI, другой SHA, изменившийся PR и неожиданную схему.
Никакие scripts этой директории сами не выкладывают приложение и не мигрируют рабочую БД.

Схема целевой документированной установки: Linux VM, Docker Compose project `kabanda`,
API 127.0.0.1:3098, фасад 127.0.0.1:3099, PostgreSQL 127.0.0.1:54329/kabanda,
PWA https://kabanda.website.yandexcloud.net/app, bucket `kabanda`.
Это сведения репозитория, не новое обследование VM. При отличии реальной установки не переделывать
её под инструкцию: сообщить расхождение. Старый Cloudflare/systemd bootstrap не выполнять.

## 1. Подготовить точную сборку без изменения сервисов

Нужен отдельный checkout с этой инструкцией и локальный полный Git-репозиторий с нужной веткой.
Штатный fetch допустим; reset/clean/checkout в папке текущей работы не использовать.
Node 22, pnpm 11.19.0, git, gh, Python 3 и Docker должны уже быть доступны оператору.
Отсутствие инструмента является блокером подготовки, не поводом автоматически обновить пакеты VM.

Задать существующие операторские пути и exact значения из handoff:

```sh
KIT=/absolute/path/to/isolated-kit-checkout
REPO=/absolute/path/to/existing/full-repository
SHA=<exact-40-character-SHA-from-verified-handoff>
RUN=<successful-CI-run-ID-for-that-SHA>
PUBLIC_CONFIG=/absolute/private/path/to/existing-public-build.json
CANDIDATE=/absolute/new/path/to/field-candidate
NODE_IMAGE='node:22-bookworm-slim@sha256:<existing-reviewed-image-digest>'
```

`PUBLIC_CONFIG` содержит ровно пять **существующих публичных** настроек:
`VITE_YANDEX_MAPS_API_KEY`, `VITE_RELAY_BOOTSTRAP_URL`, `VITE_RELAY_PUBLIC_KEY`,
`VITE_RELAY_BLOB_BUCKET`, `VITE_DIRECT_RELAY_URL` (последний пустой только если уже отключён).
Не переносить сюда API env, приватный RSA-ключ или учетные данные S3.
Не генерировать новый ключ и не менять endpoint ради прохождения проверки.
Не печатать конфигурацию/токены в чат или GitHub. JSON держать вне репозитория с доступом 0600.

```sh
python3 "$KIT/infra/release/prepare_field_release.py" verify \
  --repo "$REPO" --sha "$SHA" --run "$RUN"
python3 "$KIT/infra/release/prepare_field_release.py" prepare \
  --repo "$REPO" --sha "$SHA" --run "$RUN" \
  --output "$CANDIDATE" --public-config "$PUBLIC_CONFIG" --node-image "$NODE_IMAGE"
```

Выход: изолированный `source/`, собранный `source/apps/pwa/dist`, image
`kabanda-api:field-$SHA`, `candidate.json` с image ID/контрольными суммами,
`public-build.json`, `api.override.json`. Последний переопределяет только image,
API_BUILD_ID и EXPECTED_MIGRATION, не редактирует действующие env.
**Контейнер ещё не запущен, объекты сайта не опубликованы.** При ошибке каталог оставляется
для анализа; отсутствие итогового candidate.json означает незавершённую подготовку.
Не удалять старые образы и не перезаписывать существующий candidate/tag.

## 2. Обследовать уже разрешённую VM только чтением

Убедиться в hostname, Docker context и целевой установке. Создать новый приватный каталог отчёта
(umask 077); не использовать одно и то же имя для отчётов нескольких попыток.

```sh
umask 077
REPORT=$(mktemp -d /var/tmp/kabanda-field-preflight.XXXXXX)
docker ps --filter label=com.docker.compose.project=kabanda \
  --format '{{.ID}} {{.Label "com.docker.compose.service"}} {{.Image}} {{.Status}}'
```

Должен быть ровно один нужный running API. Присвоить его точный ID переменной API_CONTAINER,
проверив project/service labels, затем выполнить read-only probe:

```sh
docker exec -i "$API_CONTAINER" node --input-type=module \
  < "$KIT/infra/release/runtime_field_check.mjs" > "$REPORT/runtime-before.json"
docker inspect --format '{{.Image}}' "$API_CONTAINER" > "$REPORT/previous-api-image-id.txt"
docker inspect --format '{{.Config.Image}}' "$API_CONTAINER" > "$REPORT/previous-api-image-ref.txt"
docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' \
  "$API_CONTAINER" > "$REPORT/compose-files.txt"
```

Не выгружать полный `docker inspect` или полный Compose config: они могут содержать секреты.
Проверить read-only отчет: ready=true, protectedRuntime=true, правильный origin,
точный API_BUILD_ID, отсутствие active/paused/finalizing рейдов, полный список миграций,
совпадение blob bucket и SPKI fingerprint с публичной конфигурацией собранной PWA.
Публичный fingerprint можно вычислить локально, не выводя PEM:

```sh
node --input-type=module -e '
import {readFileSync} from "node:fs";
import {createPublicKey,createHash} from "node:crypto";
const config=JSON.parse(readFileSync(process.argv[1],"utf8"));
const der=createPublicKey(config.VITE_RELAY_PUBLIC_KEY.replace(/\\n/g,"\n")).export({type:"spki",format:"der"});
console.log(createHash("sha256").update(der).digest("hex"));
' "$CANDIDATE/public-build.json"
```

Сопоставить текущий deployed SHA с кандидатом. Неизвестную параллельную работу, более новую
версию или несовместимую схему не затирать. Проверить фактический Postgres volume,
достаточное место, текущие API/Relay health, доступность действующих secret/env files.
Их содержимое не выводить и не менять. Образ previous-api-image-ref должен всё ещё ссылаться
на записанный image ID; иначе отдельно сохранить именно работающий image для отката.

Сохранить предыдущий **собранный frontend dist** с полным SHA, предыдущий image и текущую схему.
Без старого dist нельзя обещать готовый откат PWA. Проверить SHA256 кандидата непосредственно
перед публикацией; не публиковать dist после непредусмотренной правки.

## 3. Миграция 0020: не пропустить и не запускать заранее

Кандидату нужна `0020_field_sync.sql`. Новый пакет стабилизации не добавляет миграций после неё.

- Если на сервере ровно 0001–0019: требуется **одна** новая миграция 0020.
- Если ровно 0001–0020: повторно применять SQL вручную не надо; штатный migrator проверит журнал.
- Любая другая схема, пропуск, неизвестная/более новая миграция: STOP и отдельный разбор.

Миграция расширяет CHECK источника посещения, добавляет структуры синхронизации/материалов,
триггеры и ordinal/index для накопленных GPS-строк. `ALTER TABLE` и создание индекса могут
блокировать/обрабатывать существующие данные. **Не считать её бесплатной или zero-downtime.**
Оценить размеры таблиц из отчёта; отрепетировать миграцию на отдельной защищённой копии
**существующей** схемы/данных и проверить возможность отката приложения. CI с пустой БД
не заменяет эту проверку большого установленного объёма.

До рабочей миграции: согласованное окно без активных рейдов, один оператор, проверенная
приватная резервная копия БД и успешная проверка её чтения/восстановления в изолированной БД.
Не восстанавливать dump поверх работающей БД и не запускать E2E fixture/bootstrap/import.

## 4. Готовый порядок обновления ПОСЛЕ разрешения владельца

Все дальнейшие команды являются изменениями окружения. Не выполнять их на этапе подготовки.

Восстановить **существующий** Compose command из сохранённых путей config_files, существующего
compose.env и project `kabanda`. Использовать shell-массив, не eval и не конкатенацию секретов.
В `BASE_COMPOSE` добавить все действующие `-f` файлы в исходном порядке. Не заменять их шаблоном.
Пример структуры (пути должны быть проверены в шаге 2):

```sh
BASE_COMPOSE=(docker compose --project-name kabanda --env-file /actual/private/compose.env \
  -f /actual/current/compose.yaml -f /actual/current/optional.override.json)
NEW_COMPOSE=("${BASE_COMPOSE[@]}" -f "$CANDIDATE/api.override.json")
"${NEW_COMPOSE[@]}" config --quiet
```

Не добавлять несуществующий optional override из примера. Перед остановкой повторить probe:
если изменились контейнер/image/build/схема/config или появился активный рейд, старый план не выполнять.
Согласованное окно не является автоматической блокировкой создания нового рейда.

При схеме 0019 и одобренной миграции:

```sh
"${BASE_COMPOSE[@]}" stop api
"${NEW_COMPOSE[@]}" run --rm --no-deps --no-build --pull never \
  --entrypoint node api dist/migrate.js
```

Это штатный migrator кандидата, не ручной запуск SQL. Он выполняет каждую миграцию в транзакции.
Не менять секреты ради migrator. Если возникла блокировка/ошибка, не убивать PostgreSQL,
не запускать другую миграцию параллельно; проверить результат транзакции/журнал и остановиться.
Если схема уже 0020, не выполнять лишнюю остановку/миграцию из этого блока.

Запуск только API из уже собранного неизменившегося образа:

```sh
"${NEW_COMPOSE[@]}" up -d --no-deps --no-build --pull never \
  --wait --wait-timeout 120 api
"${NEW_COMPOSE[@]}" exec -T api node --input-type=module \
  < "$CANDIDATE/source/infra/yandex/probe_runtime.mjs"
"${NEW_COMPOSE[@]}" exec -T api node --input-type=module \
  < "$KIT/infra/release/runtime_field_check.mjs" > "$REPORT/runtime-after.json"
```

Нужны ожидаемый API_BUILD_ID, schema0020, apiReady и encryptedRelayRoundTrip PASS,
прежние origin/fingerprint/bucket. Не продолжать к PWA после провала API/Relay.
Не перезапускать postgres, общий storage-relay, другие приложения или volumes.
Сохранить overlay как часть действующей конфигурации release: запуск одного base compose
позже может вернуть прежний image/build из неизменённого compose.env.

Публикация PWA штатным проверенным publisher (действующие приватные пути, не выдуманные):

```sh
python3 "$CANDIDATE/source/infra/yandex/publish_static.py" \
  --directory "$CANDIDATE/source/apps/pwa/dist" --release-sha "$SHA" \
  --credentials /actual/private/publisher-credentials.json \
  --console-ownership-proof /actual/private/storage-console-ownership.json \
  --bucket-public-read --snapshot-dir /actual/private/new-static-snapshots --apply
```

Эта форма предназначена для уже используемой public-static-only модели bucket.
Если установка использует другой штатный owner/baseline mode, сохранить её действующие
ownership-проверки из `infra/yandex/README.md`, не менять права ради примера.
Proof должен быть реально проверен уполномоченным оператором менее суток назад.
**Нельзя просто обновить verifiedAt или изготовить доказательство.**
Publisher сохраняет snapshot, публикует immutable assets до HTML/SW, проверяет прочитанные байты.
Это не атомарная транзакция S3; при rollback incomplete остановиться, не повторять вслепую.

## 5. Приёмка установленной версии

Проверить статические `index.html`, `/app`, manifest, `sw.js`, `sw-build-<SHA-prefix>.js`
и referenced JS/CSS: байты/хэши кандидата, HTTP caching (mutable no-store, hashed immutable).
`/api/ready` на website origin не является проверкой реального API: API работает через Relay.

На существующих аккаунтах без удаления данных: вход, список рейдов, завершённый результат,
галерея/подгрузка, карта и материалы точки. Затем несколько устройств:
навигатор отмечает состав при отправляющемся фото, переключается на Главную, повтор восстанавливается
после обрыва без дубля, карты остальных обновляются, GPS продолжает сохраняться локально.
Проверить старые локальные операции после обычного обновления PWA.

Не удалять IndexedDB, Service Worker, фото, чекины или GPS для «лечения» выкладки.
Не принудительно перезагружать активного навигатора. Закрытая/фоновая PWA не обещает
непрерывной отправки при ограничениях ОС. CI не является полевой приёмкой Safari/iPhone.

## 6. Откат и условия STOP

До активации проверить сохранённые previous dist/SHA/image ID и протестировать совместимость
предыдущего API с расширенной схемой 0020 на отдельном окружении.
После успешной миграции **не откатывать БД на 0019**, не удалять новые таблицы/посещения.
Предыдущий API при работе на0020 должен иметь `EXPECTED_MIGRATION=0020_field_sync.sql`,
иначе его readiness может отказать. Не считать такую совместимость доказанной без прогона.

Если PWA ещё не опубликована: вернуть проверенный previous API image и прежний build ID,
оставляя actual schema0020, затем проверить health/Relay. Если migration откатилась транзакцией,
сначала подтвердить фактическую схему, не угадывать EXPECTED_MIGRATION.
Если PWA уже опубликована: вернуть **проверенный предыдущий dist** штатным publisher с его SHA,
затем API. Старые клиенты могут не уметь обслуживать новые очереди: новые pending-операции
сохраняются для возобновления, не конвертируются в другие команды и не очищаются.
При несовместимости или работающих новых операциях предпочесть исправление вперёд/остановку
выкладки, а не разрушительный rollback. Позже установленную чужую версию не затирать.

Не использовать `alpha-rollback` как rollback релиза: это другой бизнес-процесс.

## Отчёт Павлу

Exact SHA/CI, старый и новый image ID/build, URL, схема до/после, факт наличия проверенного
backup и пути private snapshots без содержимого, health/Relay/static проверки,
сценарии нескольких телефонов и конкретные блокеры. Отдельно указать, что проверено
в CI, что на VM, а что на физических устройствах. До этих шагов не писать «задеплоено».
