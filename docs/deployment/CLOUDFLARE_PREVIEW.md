# Закрытый preview через Cloudflare Quick Tunnel

Этот стенд нужен, чтобы владелец мог немедленно посмотреть exact VP без merge и без изменения чужих
виртуальных хостов сервера. Fastify слушает только `127.0.0.1:3098` и отдаёт PWA и `/api` с одного origin;
единственный публичный вход — Cloudflare Quick Tunnel.

## Жёсткая граница

- `*.trycloudflare.com` — временный demo/testing URL без SLA. После остановки `cloudflared` адрес меняется.
- URL нельзя считать стабильной закрытой альфой. До приглашения других пользователей нужны named Tunnel,
  домен в зоне владельца и реальный authenticated SMTP.
- Mailpit для preview слушает только loopback; одноразовую magic-link получает оператор. Он не публикуется.
- PR остаётся draft/open. Развёртывается exact SHA, а не непроверенная рабочая директория.

## Release layout

- `/opt/kabanda/releases/<sha>` — immutable source/build exact SHA;
- `/opt/kabanda/current` — symlink на активный release;
- `/etc/kabanda/kabanda.env` — `root:root`, mode `0600`;
- `/var/backups/kabanda` — custom-format backups, readback listings, SHA-256 и build markers;
- `/var/lib/kabanda-mailpit` — bounded demo mailbox, доступный только на loopback;
- отдельные PostgreSQL role/database `kabanda_preview`, без внешнего listener;
- systemd runtime user `kabanda`, без shell и привилегий.

## One-time bootstrap чистого Ubuntu host

Команды выполняются root. Они не меняют 80/443 и не публикуют PostgreSQL/Mailpit:

```bash
apt-get update
apt-get install -y ca-certificates curl git xz-utils postgresql-16-postgis-3 postgresql-16-postgis-3-scripts
useradd --system --home-dir /opt/kabanda --shell /usr/sbin/nologin kabanda
install -d -o root -g root -m 0755 /opt/kabanda /opt/kabanda/releases
install -d -o root -g root -m 0700 /etc/kabanda /var/backups/kabanda
install -d -o kabanda -g kabanda -m 0700 /var/lib/kabanda-mailpit
```

Node.js ставится из pinned official Node release; checksum взят из его `SHASUMS256.txt`:

```bash
curl -fsSLo /tmp/node-v22.22.3-linux-x64.tar.xz \
  https://nodejs.org/dist/v22.22.3/node-v22.22.3-linux-x64.tar.xz
echo '2e5d13569282d016861fae7c8f935e741693c269101a5bebcf761a5376d1f99f  /tmp/node-v22.22.3-linux-x64.tar.xz' | sha256sum -c -
tar -xJf /tmp/node-v22.22.3-linux-x64.tar.xz -C /usr/local --strip-components=1
test "$(node --version)" = 'v22.22.3'
corepack enable
corepack install --global pnpm@11.19.0
test "$(pnpm --version)" = '11.19.0'
git --version
curl --version
```

Mailpit ставится только из official release с зафиксированным checksum (для текущего stand — `v1.31.0`):

```bash
curl -fsSLo /tmp/mailpit-linux-amd64.tar.gz \
  https://github.com/axllent/mailpit/releases/download/v1.31.0/mailpit-linux-amd64.tar.gz
echo '076b5ded9a2182842b93e761b9586a1a251445bffe2666f9f22a6dc14470237d  /tmp/mailpit-linux-amd64.tar.gz' | sha256sum -c -
tar -xzf /tmp/mailpit-linux-amd64.tar.gz -C /tmp mailpit
install -o root -g root -m 0755 /tmp/mailpit /usr/local/bin/mailpit
```

Создать least-privilege role/database один раз; пароль — hex и не печатается:

```bash
db_password="$(openssl rand -hex 24)"
sudo -u postgres psql -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE kabanda_preview LOGIN PASSWORD '${db_password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS"
sudo -u postgres createdb --owner=kabanda_preview kabanda_preview
sudo -u postgres psql -v ON_ERROR_STOP=1 -d kabanda_preview -c 'CREATE EXTENSION postgis'
printf '%s' "${db_password}" > /etc/kabanda/db-password
chmod 0600 /etc/kabanda/db-password
unset db_password
```

`cloudflared` ставится из pinned official Cloudflare release в exact path, который использует unit:

```bash
curl -fsSLo /tmp/cloudflared-linux-amd64 \
  https://github.com/cloudflare/cloudflared/releases/download/2026.8.2/cloudflared-linux-amd64
echo 'fcfb02b575a52ca1af2e3267af4e1517bcdeb30ac48c834c69abaed3c0576ad2  /tmp/cloudflared-linux-amd64' | sha256sum -c -
install -o root -g root -m 0755 /tmp/cloudflared-linux-amd64 /usr/local/bin/cloudflared
/usr/local/bin/cloudflared --version
```

Затем unit templates копируются из exact release:

```bash
install -o root -g root -m 0644 infra/stand/kabanda-api.service /etc/systemd/system/
install -o root -g root -m 0644 infra/stand/kabanda-mailpit.service /etc/systemd/system/
install -o root -g root -m 0644 infra/stand/kabanda-quick-tunnel.service /etc/systemd/system/
systemctl daemon-reload
systemctl start kabanda-mailpit.service kabanda-quick-tunnel.service
```

Quick Tunnel намеренно не enable-ится: после reboot/restart он получает другой URL, который нужно заново
согласовать с `APP_ORIGIN`.

## Сборка exact release

```bash
sha='<reviewed-full-git-sha>'
release="/opt/kabanda/releases/${sha}"
git clone --filter=blob:none https://github.com/motpavel/kabanda.git "${release}"
git -C "${release}" checkout --detach "${sha}"
corepack enable
pnpm --dir "${release}" install --frozen-lockfile
GITHUB_SHA="${sha}" pnpm --dir "${release}" build
test "$(git -C "${release}" rev-parse HEAD)" = "${sha}"
```

После получения URL из `journalctl -u kabanda-quick-tunnel.service` создаётся
`/etc/kabanda/kabanda.env` по `infra/stand/kabanda.env.example`: `API_BUILD_ID` равен полному SHA,
`APP_ORIGIN` — exact HTTPS URL, а `DATABASE_URL` использует пароль из `/etc/kabanda/db-password`.
Файл создаётся с `umask 077` и остаётся `root:root 0600`; secrets не печатаются в journal/terminal.
Для внешнего SMTP используется ровно один режим: `SMTP_SECURE=true` для implicit TLS либо
`SMTP_REQUIRE_TLS=true` для обязательного STARTTLS, вместе с парой `SMTP_USER`/`SMTP_PASSWORD`.
Production API запускается только с `ALPHA_ACCESS_MODE=enforced` и отдельным root-owned
`ALPHA_ACCESS_SECRET` длиной не менее 32 символов. Значение секрета не меняют между enroll, login и
rollback: оно является ключом HMAC, а не обычной rotate-on-restart настройкой.

## Обязательный порядок обновления

1. Получить exact reviewed SHA, установить зависимости с frozen lockfile и собрать PWA/API с одинаковым
   `GITHUB_SHA`/`API_BUILD_ID`.
2. Запустить Quick Tunnel, взять фактический HTTPS URL из journal, записать его как exact `APP_ORIGIN`.
3. Остановить API. Загрузить root-owned env и выполнить `infra/stand/backup-before-migrate.sh`.
   Миграция запрещена, если `pg_dump`, `pg_restore --list`, checksum или build marker не созданы.
4. Из нового immutable release, ещё до переключения symlink, выполнить
   `node /opt/kabanda/releases/<sha>/apps/api/dist/migrate.js`. Он завершится ошибкой, если migration set не
   заканчивается exact `EXPECTED_MIGRATION`.
5. До запуска нового API записать grant для каждого согласованного alpha email через exact-built
   `alpha-access.js`. Сначала выполнить dry-run, затем apply с буквальным подтверждением. Общий active cap
   сериализован в PostgreSQL и равен 20; обход таблицы или ручной `INSERT` запрещён.
6. Только после успешной миграции и enroll атомарно переключить `current`, установить units из этого release,
   запустить `kabanda-api.service` и выполнить публичный
   `node infra/stand/smoke.mjs <origin> <sha>`.
7. Отдельно проверить login: запросить ссылку enrolled тестовому email, забрать одноразовый URL из loopback Mailpit,
   войти, создать Кабанду и открыть основной `/app` flow.
8. После создания конкретной alpha Кабанды выполнить идемпотентный import manifest exact release. Без этого
   карта новой database пуста. `source_checked` точки разрешают проверить карту и pre-start UX, но не
   разрешают canonical start. Статус `field_verified` выставляется только после реальной проверки точки и
   обновления evidence manifest; ручное изменение DB ради старта запрещено.

EnvironmentFile перед backup загружается с экспортом, чтобы дочерние `pg_*` и script получили exact env:

```bash
set -a
. /etc/kabanda/kabanda.env
set +a
release="/opt/kabanda/releases/${API_BUILD_ID}"
"${release}/infra/stand/backup-before-migrate.sh"
node "${release}/apps/api/dist/migrate.js"

ALPHA_ACCESS_COMMAND=enroll \
ALPHA_ACCESS_EMAIL='<approved-alpha-email>' \
ALPHA_EXPECTED_DATABASE='kabanda_preview' \
ALPHA_EXPECTED_API_BUILD="${API_BUILD_ID}" \
node "${release}/apps/api/dist/alpha-access.js"

ALPHA_ACCESS_COMMAND=enroll \
ALPHA_ACCESS_EMAIL='<approved-alpha-email>' \
ALPHA_EXPECTED_DATABASE='kabanda_preview' \
ALPHA_EXPECTED_API_BUILD="${API_BUILD_ID}" \
ALPHA_ACCESS_APPLY=true \
ALPHA_ACCESS_CONFIRMATION='ENROLL:<approved-alpha-email>' \
node "${release}/apps/api/dist/alpha-access.js"

ALPHA_KABANDA_ID='<exact-kabanda-uuid>' \
ALPHA_OWNER_EMAIL='<exact-owner-email>' \
node "${release}/apps/api/dist/import-alpha.js"
```

Когда manifest содержит `field_verified`, к import обязательно добавляется
`ALPHA_FIELD_EVIDENCE_ROOT=/absolute/restricted/operator-storage`. Import до любых DB mutations проверяет,
что каждый actual evidence-файл после realpath остаётся внутри root и его SHA-256 совпадает с sidecar.
Raw evidence, resolved path и bytes не выводятся и не попадают в GitHub.

Backup script принимает только loopback PostgreSQL URI и раскладывает его в libpq environment; пароль не
попадает в аргументы `pg_dump`, listing, marker или stdout.

Import возвращает `reportId`, `collectionId`, `rowCount` и `replayed`. Эти bounded поля фиксируются в
restricted operator evidence без email, invite/session tokens и координат. Повторный запуск exact manifest
должен вернуть replay/idempotent result, а не создать второй collection.

`alpha-access.js` также поддерживает `status` и `revoke`. `revoke` инвалидирует неиспользованные magic-link
и все серверные sessions только этой identity; dry-run остаётся режимом по умолчанию, apply требует
`ALPHA_ACCESS_CONFIRMATION='REVOKE:<exact-email>'`. Публичное evidence хранит только bounded counts и grant
UUID, без email и токенов.

Readiness проверяет PostgreSQL, PostGIS и exact последнюю миграцию. Production запросы с чужим host,
не-HTTPS proxy context или чужим `Origin` отклоняются fail-closed.

## Rollback

Для остановки одной dedicated alpha Кабанды сначала выполнить fail-closed dry-run exact-built команды.
Она принимает только exact Kabanda UUID, owner email, database, build и migration context. Apply разрешён,
только если все активные участники принадлежат этой Кабанде, у каждого есть active grant и ни у кого нет
активного membership в другой неархивированной Кабанде. Транзакция `SERIALIZABLE` блокирует grants,
повторно проверяет scope, отзывает grants/invites/links/sessions, архивирует Кабанду и сохраняет immutable
bounded report; завершённые `raid_results` не удаляются.

```bash
ALPHA_KABANDA_ID='<exact-kabanda-uuid>' \
ALPHA_OWNER_EMAIL='<exact-owner-email>' \
ALPHA_EXPECTED_DATABASE='kabanda_preview' \
ALPHA_EXPECTED_API_BUILD="${API_BUILD_ID}" \
node "${release}/apps/api/dist/alpha-rollback.js"

ALPHA_KABANDA_ID='<exact-kabanda-uuid>' \
ALPHA_OWNER_EMAIL='<exact-owner-email>' \
ALPHA_EXPECTED_DATABASE='kabanda_preview' \
ALPHA_EXPECTED_API_BUILD="${API_BUILD_ID}" \
ALPHA_ROLLBACK_APPLY=true \
ALPHA_ROLLBACK_CONFIRMATION='ROLLBACK:<exact-kabanda-uuid>' \
node "${release}/apps/api/dist/alpha-rollback.js"
```

Conflict/serialization failure означает `NO CHANGE`: оператор заново выполняет dry-run, а не повторяет
apply вслепую. Archived Kabanda является canonical access boundary для прямых API reads/writes.

Старый binary нельзя запускать поверх несовместимо изменённой схемы. Предпочтителен совместимый forward fix.
Если нужен restore, API сначала останавливается, backup сверяется по `.sha256` и читается через
`pg_restore --list`, затем база восстанавливается в изолированную database. Только после readiness на
совместимом exact release переключается `current`.

Обычный restart/update никогда не удаляет PostgreSQL data или backups. Named Tunnel credentials, когда он
появится, хранятся persistent и root-owned; Quick Tunnel credentials не имеет.
