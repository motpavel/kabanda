# Обновление Кабанды: единая инструкция Codex

## Границы

Приложение и инструменты: PR #74, `chatgpt/field-stabilization`.
До отдельного разрешения Павла выполнить **только подготовку и чтение**, не публикацию.
Не merge draft PR, не force-push, не затирать незавершённую работу. Не менять секреты,
ACL/DNS/firewall, общий Relay, другие приложения. Не очищать IndexedDB, GPS/чекины/фото.

Exact SHA и успешный CI run взять из финальной подтверждённой передачи #74, не произвольного
latest. Пакет #70 закреплён за другим приложением/0019 и не подходит для apply этой версии.
`prepare_field_release.py` проверяет exact SHA, текущий PR, CI и неизменность миграций относительно #73.
Скрипт имеет только verify/prepare, не deploy/migrate. `runtime_field_check.mjs` только читает.

Документированная установка: Linux VM, Docker Compose project `kabanda`, API127.0.0.1:3098,
Relay facade127.0.0.1:3099, PostgreSQL127.0.0.1:54329/kabanda,
PWA https://kabanda.website.yandexcloud.net/app, bucket `kabanda`.
Это не обследование VM этим чатом. При расхождении остановиться, не переделывать установку
под инструкцию. Старый Cloudflare/systemd bootstrap не выполнять.

## 1. Изолированная сборка

Нужны существующие Node22, pnpm11.19.0, Python3, git, gh, Docker. Автоматически не обновлять VM.
Для publisher нужен уже используемый Python runtime с boto3.
Использовать отдельный checkout комплекта и полный локальный Git-репозиторий с нужным SHA.
Fetch допустим, reset/clean/переключение рабочей папки с изменениями запрещены.

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
вне рабочей папки с чужими изменениями. PUBLIC_CONFIG содержит ровно пять прежних **публичных**
полей: VITE_YANDEX_MAPS_API_KEY, VITE_RELAY_BOOTSTRAP_URL, VITE_RELAY_PUBLIC_KEY,
VITE_RELAY_BLOB_BUCKET, VITE_DIRECT_RELAY_URL (пустой только если уже отключён).
Не переносить API env, private RSA key/S3 credentials. Не генерировать новые ключи.
Не печатать полный env в чат/GitHub. Хранить JSON вне репозитория с доступом0600.

```sh
python3 "$KIT/infra/release/prepare_field_release.py" verify \
  --repo "$REPO" --sha "$SHA" --run "$RUN"
python3 "$KIT/infra/release/prepare_field_release.py" prepare \
  --repo "$REPO" --sha "$SHA" --run "$RUN" --output "$CANDIDATE" \
  --public-config "$PUBLIC_CONFIG" --node-image "$NODE_IMAGE"
```

Выход: чистый exact source/, PWA source/apps/pwa/dist, Linux/amd64 image
`kabanda-api:field-$SHA`, candidate.json с image ID/хэшами файлов,
public-build.json и api.override.json (только image, API_BUILD_ID, EXPECTED_MIGRATION).
Сервис не запускается, S3 не изменяется. При ошибке каталог оставляется; отсутствие
итогового candidate.json означает незавершённую подготовку. Старые образы не удалять.

## 2. Проверить реальную установку только чтением

Сверить hostname, Docker context, ровно один running API с правильными project/service labels.
Создать новый приватный каталог и установить API_CONTAINER в проверенный полный container ID.

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

Не выводить полный inspect/Compose config с секретами. Нужны ready=true, protectedRuntime=true,
правильный origin/build, отсутствие active/paused/finalizing рейдов, точная схема0001–0019 или0001–0020.
Проверить volume kabanda_postgres_data, свободное место, существующие env/secret files, фактический
размер таблиц из отчёта. API SHA не должен содержать неизвестных/более новых изменений относительно
кандидата. Не затирать параллельную выкладку.

Сравнить blob bucket и SPKI fingerprint runtime с публичной конфигурацией кандидата:

```sh
node --input-type=module -e '
import {readFileSync} from "node:fs";
import {createPublicKey,createHash} from "node:crypto";
const c=JSON.parse(readFileSync(process.argv[1],"utf8"));
const der=createPublicKey(c.VITE_RELAY_PUBLIC_KEY.replace(/\\n/g,"\n")).export({type:"spki",format:"der"});
console.log(createHash("sha256").update(der).digest("hex"));
' "$CANDIDATE/public-build.json"
```

Сохранить previous API image ID/tag и **предыдущий собранный PWA dist с полным SHA**.
Проверить, что tag ещё указывает на image ID. Без старого dist откат интерфейса не готов.
Перед публикацией сверить candidate.json: дерево исходников, image ID и SHA256 всех файлов dist.
Изменившийся кандидат не публиковать.

## 3. Подготовить миграцию/откат до изменения сервера

Нужна `0020_field_sync.sql`; более новых миграций эта стабилизация не добавляет.
При0001–0019 применить только0020, при0001–0020 не запускать SQL повторно. Любые пропуски,
неизвестная/более новая схема означают STOP.

0020 расширяет CHECK source, добавляет аудит/материалы/ревизии/триггеры и ordinal/index для
GPS-строк. ALTER/индекс могут обрабатывать существующие строки и удерживать блокировки.
**Не обещать zero-downtime.** На защищённой отдельной копии установленной схемы и данных
отрепетировать миграцию и совместимость предыдущего API со схемой0020. Пустая CI-БД этого не доказывает.

Нужны проверенная приватная резервная копия, проверка её чтения/восстановления в изолированной БД,
окно без рейдов и один оператор. Не восстанавливать dump поверх working DB, не запускать E2E
fixture/bootstrap/import/enroll и не создавать пользователей ради smoke.

## 4. Обновить ТОЛЬКО ПОСЛЕ отдельного разрешения

Собрать BASE_COMPOSE из **всех действующих** файлов из container labels в том же порядке и
существующего compose.env. Использовать массив, не eval. Пример структуры, не готовые пути:

```sh
BASE_COMPOSE=(docker compose --project-name kabanda --env-file /actual/private/compose.env \
  -f /actual/current/compose.yaml)
# Добавить сюда реальные действующие overlays, если они есть; не придумывать их.
NEW_COMPOSE=("${BASE_COMPOSE[@]}" -f "$CANDIDATE/api.override.json")
"${NEW_COMPOSE[@]}" config --quiet
```

Перед остановкой повторить read-only probe и сверить container/image/build/schema/config,
отсутствие новых рейдов. Старые команды не выполнять при изменившихся исходных условиях.
Окно согласуется отдельно: read-only probe не блокирует создание рейда.

Только при0019 и согласованной0020:

```sh
"${BASE_COMPOSE[@]}" stop api
"${NEW_COMPOSE[@]}" run --rm --no-deps --pull never --entrypoint node api dist/migrate.js
```

У `compose run` нет флага --no-build; используется уже существующий неизменённый image,
pull_policy=never, --pull never и отсутствие --build. Перед командой обязательно сверить
image ID. Команда использует штатный migrator и существующие права. Каждая миграция в транзакции.
При ошибке/блокировке проверить транзакцию и журнал, не убивать PostgreSQL, не запускать второй
migrator, не менять секреты/права ради прохождения. При уже0020 этот блок не выполняется.

Запустить толькоAPI и проверить его до публикацииPWA:

```sh
"${NEW_COMPOSE[@]}" up -d --no-deps --no-build --pull never --wait --wait-timeout 120 api
"${NEW_COMPOSE[@]}" exec -T api node --input-type=module \
  < "$CANDIDATE/source/infra/yandex/probe_runtime.mjs"
"${NEW_COMPOSE[@]}" exec -T api node --input-type=module \
  < "$KIT/infra/release/runtime_field_check.mjs" > "$REPORT/runtime-after.json"
```

Нужны exactAPI_BUILD_ID, schema0020, apiReady/encryptedRelayRoundTripPASS и прежнийSPKI.
Не перезапускать postgres/общийstorage-relay/volumes. Сохранить overlay как часть действующего
release: следующий запуск толькоbase может вернуть прежний image/build из старогоenv.

Штатный publisher (только подтверждённые действующие приватные пути):

```sh
python3 "$CANDIDATE/source/infra/yandex/publish_static.py" \
  --directory "$CANDIDATE/source/apps/pwa/dist" --release-sha "$SHA" \
  --credentials /actual/private/publisher-credentials.json \
  --console-ownership-proof /actual/private/storage-console-ownership.json \
  --bucket-public-read --snapshot-dir /actual/private/new-static-snapshots --apply
```

Эта форма для прежней public-static-only моделиbucket. При другом установленном owner/baseline
режиме сохранить его штатные проверки из infra/yandex/README.md, не менятьACL ради примера.
Ownership-proof должен быть **действительно** проверен уполномоченным оператором менее суток назад,
не просто обновлён verifiedAt. Publisher делает private snapshot, assets передHTML/SW и readback.
Это не атомарныйS3-deploy: при rollback incomplete не повторять вслепую.

## 5. Проверки после выкладки

Проверить /app,index.html,manifest,sw.js,sw-build-<SHA-prefix>.js и referencedJS/CSS: хэши
кандидата и HTTPcache (mutable no-store, hashed immutable). Website /api/ready не проверяетbackend,
он доступен черезRelay.
На существующих аккаунтах: вход, рейды, результат/фото/подгрузка, карта, материалы точки.
Несколько устройств: фото удерживается, навигатор отмечает состав, переходит наГлавную,
после обрыва retry восстанавливается без дубля, другие карты обновляются, GPS пишется локально.
Проверить прежние сохранённые операции после обычного обновленияPWA.

Не удалять ServiceWorker/IndexedDB/очереди для «лечения», не force-reload активногонавигатора.
Фоновая/закрытаяPWA не обещает непрерывной работы вопреки ограничениямОС.
CI не заменяет реальную приёмкуiPhone/Android и рабочегоRelay.

## 6. Откат

До выкладки проверить olddist/image и совместимость старогоAPI с0020 на отдельнойкопии.
После миграции не делатьdown0020 и не удалять новыетаблицы/посещения.
Для старогоAPI на0020 требуется EXPECTED_MIGRATION=0020_field_sync.sql, иначе readinessможетотказать.
Не объявлять совместимость доказанной безпроверки.
ЕслиPWA ещёнепубликована: вернуть проверенныйoldAPI/image/build, сохранить actualschema, проверитьRelay.
ЕслиPWA опубликована: сначала вернуть проверенныйolddist штатнымpublisher сегоSHA, затемAPI.
Сохранить новыеpendingоперации для последующего восстановления; старыйклиент можетихнеобслуживать.
При несовместимости выбрать исправлениевперёд/остановкувыкладки, не разрушительныйrestoreБД.
Более новыйчужойrelease неоткатывать. `alpha-rollback` неявляетсяоткатомрелиза.

## Отчёт владельцу

ExactSHA/CI; старый/новыйimageID/build; URL; схемадо/после; проверенныйbackup/private snapshots
безсодержимого; health/Relay/static; сценарииустройств; конкретныеблокеры.
Разделить CI,VM,физическиетелефоны. До фактическойпубликации не писать «задеплоено».
