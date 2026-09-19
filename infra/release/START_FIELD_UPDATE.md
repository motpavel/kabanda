# Обновление Кабанды: инструкция Codex

## Границы работы

Приложение и инструменты находятся в PR #74, ветка `chatgpt/field-stabilization`.
До отдельного разрешения Павла выполнить только подготовку сборки и чтение состояния сервера.
Не выполнять merge, deploy, force-push; не затирать незавершённые изменения; не менять секреты,
ACL, DNS, firewall, общий Relay и другие приложения. Не очищать IndexedDB, GPS, чекины и фото.

Точный SHA и успешный CI run взять из итоговой подтверждённой передачи #74. Не использовать
произвольный latest. Старый пакет #70 закреплён за другим приложением и схемой 0019.
`prepare_field_release.py` проверяет SHA, текущий PR, CI и набор миграций. У него есть только
verify/prepare, без deploy/migrate. `runtime_field_check.mjs` выполняет только чтение.

Документированная установка: Linux VM, Docker Compose project `kabanda`, API на 127.0.0.1:3098,
фасад Relay на 127.0.0.1:3099, PostgreSQL на 127.0.0.1:54329/kabanda,
PWA https://kabanda.website.yandexcloud.net/app, bucket `kabanda`.
Это сведения репозитория, а не новое обследование VM. При расхождении остановиться и сообщить
его, не переделывать сервер под инструкцию. Старый Cloudflare/systemd bootstrap не выполнять.

## 1. Подготовить изолированную сборку

Нужны уже установленные Node 22, pnpm 11.19.0, Python 3, git, gh и Docker. Для publisher нужен
действующий Python runtime с boto3. Не обновлять системные пакеты VM автоматически.
Использовать отдельный checkout комплекта и полный локальный Git-репозиторий с нужным SHA.
Fetch допустим; reset/clean и переключение рабочей папки с изменениями запрещены.

```sh
KIT=/absolute/path/to/isolated-kit-checkout
REPO=/absolute/path/to/existing/full-repository
SHA='exact-40-character-SHA-from-verified-handoff'
RUN='successful-CI-run-ID-for-that-SHA'
PUBLIC_CONFIG=/actual/private/public-build.json
CANDIDATE=/absolute/new/path/to/field-candidate
NODE_IMAGE='node:22-bookworm-slim@sha256:existing-reviewed-image-digest'
```

Подставить действующие значения, не выполнять placeholders. Новый CANDIDATE должен находиться
вне исходной рабочей папки. PUBLIC_CONFIG содержит ровно пять прежних публичных настроек:
VITE_YANDEX_MAPS_API_KEY, VITE_RELAY_BOOTSTRAP_URL, VITE_RELAY_PUBLIC_KEY,
VITE_RELAY_BLOB_BUCKET, VITE_DIRECT_RELAY_URL. Последнее поле пустое только если уже отключено.
Не переносить сюда API env, приватный RSA-ключ или реквизиты S3. Не создавать новые ключи.
Не печатать полные env в чат/GitHub. JSON хранить вне репозитория с правами 0600.

```sh
python3 "$KIT/infra/release/prepare_field_release.py" verify \
  --repo "$REPO" --sha "$SHA" --run "$RUN"
python3 "$KIT/infra/release/prepare_field_release.py" prepare \
  --repo "$REPO" --sha "$SHA" --run "$RUN" --output "$CANDIDATE" \
  --public-config "$PUBLIC_CONFIG" --node-image "$NODE_IMAGE"
```

Результат: чистый source/, PWA в source/apps/pwa/dist, образ Linux/amd64
`kabanda-api:field-$SHA`, candidate.json с image ID и хэшами файлов,
public-build.json и api.override.json. Последний меняет только image, API_BUILD_ID и
EXPECTED_MIGRATION для будущего запуска. Действующие env не редактируются.
Контейнер не запускается, S3 не изменяется. При ошибке каталог остаётся для анализа;
без итогового candidate.json подготовка не завершена. Старые образы не удалять.

## 2. Проверить действующую VM только чтением

Сверить hostname, Docker context и наличие ровно одного running API с правильными labels.
Создать новый приватный каталог, установить API_CONTAINER в проверенный полный container ID:

```sh
umask 077
REPORT=$(mktemp -d /var/tmp/kabanda-field-preflight.XXXXXX)
docker ps --filter label=com.docker.compose.project=kabanda \
  --format '{{.ID}} {{.Label "com.docker.compose.service"}} {{.Image}} {{.Status}}'
docker exec -i "$API_CONTAINER" node --input-type=module \
  < "$KIT/infra/release/runtime_field_check.mjs" > "$REPORT/runtime-before.json"
docker inspect --format '{{.Image}}' "$API_CONTAINER" > "$REPORT/previous-api-image-id.txt"
docker inspect --format '{{.Config.Image}}' "$API_CONTAINER" > "$REPORT/previous-api-image-ref.txt"
docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' \
  "$API_CONTAINER" > "$REPORT/compose-files.txt"
```

Не выводить полный inspect/Compose config с секретами. В отчёте нужны ready=true,
protectedRuntime=true, правильные origin/build, отсутствие active/paused/finalizing рейдов,
точный список миграций 0001–0019 либо 0001–0020. Проверить volume kabanda_postgres_data,
свободное место, доступность прежних env/secret files и размеры таблиц из отчёта.
Не затирать неизвестные или более новые изменения API, параллельную работу или выкладку.

Сравнить blob bucket и SPKI fingerprint действующего Relay с публичным конфигом кандидата:

```sh
node --input-type=module -e '
import {readFileSync} from "node:fs";
import {createPublicKey,createHash} from "node:crypto";
const c=JSON.parse(readFileSync(process.argv[1],"utf8"));
const der=createPublicKey(c.VITE_RELAY_PUBLIC_KEY.replace(/\\n/g,"\n")).export({type:"spki",format:"der"});
console.log(createHash("sha256").update(der).digest("hex"));
' "$CANDIDATE/public-build.json"
```

Сохранить прежний API image ID/tag и предыдущий собранный PWA dist с полным SHA.
Проверить, что tag всё ещё указывает на записанный image ID. Без старого dist откат PWA не готов.
Перед публикацией сверить исходный tree, image ID и SHA256 всех файлов с candidate.json.
Изменившийся после подготовки кандидат не публиковать.

## 3. Подготовить миграцию и откат

Кандидату нужна `0020_field_sync.sql`; миграций после неё в этой стабилизации нет.
Если установлены ровно 0001–0019, применяется только 0020. Если ровно 0001–0020,
повторно запускать SQL не нужно. Пропуски, неизвестная или более новая схема означают STOP.

0020 расширяет CHECK источника посещений, добавляет аудит, материалы, ревизии, триггеры и
ordinal/index для GPS-строк. ALTER TABLE и создание индекса могут обрабатывать существующие
строки и удерживать блокировки. Не обещать обновление без простоя.
На защищённой отдельной копии установленной схемы и данных отрепетировать миграцию и
совместимость прежнего API со схемой 0020. Пустая CI-БД этого не доказывает.

До рабочей миграции нужны согласованное окно без рейдов, один оператор, приватная резервная
копия БД и проверка её чтения/восстановления в изолированном окружении. Не восстанавливать dump
поверх working DB. Не запускать E2E fixture, bootstrap, import или enroll на рабочей установке.

## 4. Обновление после отдельного разрешения

Восстановить BASE_COMPOSE из всех действующих config_files в исходном порядке и существующего
compose.env. Использовать shell-массив, не eval. Ниже структура команды, а не готовые пути:

```sh
BASE_COMPOSE=(docker compose --project-name kabanda --env-file /actual/private/compose.env \
  -f /actual/current/compose.yaml)
# Добавить реальные действующие overlays, если они есть. Не придумывать новые пути.
NEW_COMPOSE=("${BASE_COMPOSE[@]}" -f "$CANDIDATE/api.override.json")
"${NEW_COMPOSE[@]}" config --quiet
```

Перед остановкой повторить read-only probe: container/image/build/schema/config должны совпадать
с проверенными исходными данными, активных рейдов быть не должно. При изменении условий не
исполнять старый план. Read-only probe сам по себе не блокирует создание новых рейдов.

Только при схеме 0019 и согласованной миграции:

```sh
"${BASE_COMPOSE[@]}" stop api
"${NEW_COMPOSE[@]}" run --rm --no-deps --pull never --entrypoint node api dist/migrate.js
```

У compose run нет флага --no-build. Здесь используются уже подготовленный image,
pull_policy=never, --pull never и отсутствие --build. До запуска сверить image ID.
Штатный migrator выполняет каждую миграцию в транзакции. При ошибке или блокировке проверить
транзакцию и журнал, не убивать PostgreSQL и не запускать второй migrator параллельно.
Не менять права и секреты ради прохождения. При уже установленной 0020 этот блок не нужен.

Запустить только API, проверить его до публикации интерфейса:

```sh
"${NEW_COMPOSE[@]}" up -d --no-deps --no-build --pull never --wait --wait-timeout 120 api
"${NEW_COMPOSE[@]}" exec -T api node --input-type=module \
  < "$CANDIDATE/source/infra/yandex/probe_runtime.mjs"
"${NEW_COMPOSE[@]}" exec -T api node --input-type=module \
  < "$KIT/infra/release/runtime_field_check.mjs" > "$REPORT/runtime-after.json"
```

Нужны точный API_BUILD_ID, схема 0020, apiReady/encryptedRelayRoundTrip PASS и прежний SPKI.
Не перезапускать PostgreSQL, общий storage-relay или volumes. Сохранить overlay как часть
действующего release: следующий запуск одного base может вернуть прежний image/build.

Публикация PWA штатным publisher с проверенными действующими приватными путями:

```sh
python3 "$CANDIDATE/source/infra/yandex/publish_static.py" \
  --directory "$CANDIDATE/source/apps/pwa/dist" --release-sha "$SHA" \
  --credentials /actual/private/publisher-credentials.json \
  --console-ownership-proof /actual/private/storage-console-ownership.json \
  --bucket-public-read --snapshot-dir /actual/private/new-static-snapshots --apply
```

Эта форма для ранее используемой public-static-only модели bucket. При другом owner/baseline
режиме сохранить его проверки из infra/yandex/README.md, не менять ACL ради примера.
Ownership-proof должен быть действительно проверен уполномоченным оператором менее суток назад,
а не просто иметь обновлённое verifiedAt. Publisher сохраняет private snapshot, загружает assets
до HTML/SW и проверяет readback. Это не атомарная транзакция S3: при rollback incomplete
остановиться, не повторять вслепую.

## 5. Проверки установленной версии

Проверить /app, index.html, manifest, sw.js, sw-build-<SHA-prefix>.js и referenced JS/CSS:
хэши кандидата и HTTP cache (mutable no-store, hashed immutable). Website /api/ready не
проверяет backend: он работает через Relay.

На существующих аккаунтах проверить вход, список рейдов, результат и фотографии, подгрузку,
карту и материалы точки. Затем несколько устройств: фото отправляется, навигатор отмечает
состав, переходит на Главную, после обрыва операция восстанавливается без дубля, карты остальных
обновляются, GPS сохраняется локально. Проверить прежние очереди после обычного обновления PWA.

Не удалять Service Worker, IndexedDB и очереди как способ «починить» выкладку; не делать
принудительную перезагрузку активного навигатора. Фоновая/закрытая PWA не обещает непрерывную
работу вопреки ограничениям ОС. CI не заменяет реальную приёмку iPhone/Android и рабочего Relay.

## 6. Откат

До выкладки проверить old dist/image и совместимость старого API с 0020 на отдельной копии.
После успешной миграции не делать down 0020 и не удалять новые таблицы/посещения.
Старому API на новой схеме нужен EXPECTED_MIGRATION=0020_field_sync.sql, иначе readiness может
отказать. Не считать совместимость доказанной без проверки.

Если PWA ещё не опубликована: вернуть проверенный старый image/build, сохранить фактическую
схему, проверить Relay. Если опубликована: сначала вернуть проверенный старый dist штатным
publisher с его SHA, затем API. Новые pending-операции сохранить для последующего восстановления;
старый клиент может не уметь их обслуживать. Не конвертировать их в другие команды.
При несовместимости выбрать исправление вперёд или остановку выкладки, не разрушительный restore БД.
Более новый чужой release не откатывать. alpha-rollback не является откатом релиза.

## Отчёт Павлу

Сообщить exact SHA/CI, старый и новый image ID/build, URL, схему до/после, наличие проверенного
backup и пути private snapshots без содержимого, результаты health/Relay/static и сценариев
устройств, конкретные блокеры. Разделить проверки CI, VM и физических телефонов.
До фактической публикации не писать «задеплоено».
