# Runbook приёмки закрытого VP

Этот runbook относится к #38 и проверяет один точный артефакт КАБАНДЫ: автоматикой, на реальных
iOS/Android, в одном внутреннем рейде и затем в закрытой альфе до 20 человек. Он не разрешает public
production launch, native wrapper или расширение аудитории.

## Правила evidence

- Один автоматический запуск получает отдельный неизменяемый `E2E_RUN_ID` в формате UUID. Synthetic user
  содержит UUID в email/display name, а guarded fixture разрешает inspect/write только для принадлежащих
  этому user Кабанд и рейдов; browser resources изолируются отдельным context.
- До первого теста в отчёте фиксируются source base/head/tree, PWA/client build, manifest/service-worker,
  API build, schema/migration и SHA-256 всех synthetic fixtures.
- E2E database всегда называется ровно `kabanda_e2e`. Её immutable PostgreSQL
  `COMMENT ON DATABASE` равен ровно `kabanda-e2e-disposable-v1`. Имя database, COMMENT marker и
  `E2E_RUN_ID` — три разных поля и не выводятся друг из друга.
- E2E URL указывает только на loopback и использует отдельный login `kabanda_e2e` с непустым паролем,
  без URL options и без SUPERUSER/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS. Runner требует заранее
  выставленные `NODE_ENV=test`, `KABANDA_E2E=true`, UUID `E2E_RUN_ID` и не создаёт эти safety markers сам.
- Текущий runner намеренно не удаляет row-level данные: завершённый рейд содержит production-like immutable
  result rows. Retention-zero cleanup для CI — уничтожение внешнего disposable service после буквальной
  проверки имени и COMMENT marker. Exact row cleanup остаётся `Pending` до отдельного ownership-механизма и
  не репетируется обходом immutable triggers; broad/shared database не используется и не очищается.
- Публичное evidence не содержит координат, GeoJSON, route polyline, private media, токенов, email,
  телефонов или имён. Raw JSON/GeoJSON/route и оригиналы фото остаются в restricted local storage; в GitHub
  допустимы только SHA-256, агрегаты и sanitized изображения.
- Ошибки и неудачные прогоны append-only. Их дополняют повторным результатом и ссылкой на correction issue,
  но не удаляют и не превращают задним числом в `Pass`.
- Любое ручное изменение DB/object data, сделанное ради зелёного результата, фиксируется как manual repair и
  закрывает GO для этого запуска.

## Авторизация, согласие и безопасность

До физического теста владелец подтверждает exact artifact, устройства, маршрут, участников, окно хранения
evidence и support limit. Каждый участник явно соглашается на геолокацию, фотографии и privacy-safe
диагностику; отзыв согласия останавливает дальнейший сбор для этого участника.

- Телефон не используется во время движения. Установка, чекин, handoff, camera, recovery и интервью
  выполняются только после безопасной остановки.
- Маршрут, погода и состояние велосипедов проверяются организатором отдельно от приложения.
- Screen-awake/Wake Lock и ограничения background GPS объясняются навигатору до старта.
- При privacy leak, false-green GPS, потере принятого route/check-in/media или неопределённом rollback тест
  немедленно останавливается.

## 1. Автоматический gate

Текущая автоматика — риск-критичный subset из двух Playwright specs, а не полная замена физической приёмки.
Для exact head она обязана доказать:

1. Unit, typecheck и production build зелёные.
2. API/PostgreSQL integration стартует с пустой disposable DB и применяет все миграции.
3. `golden-raid.spec.ts` проходит owner create/start, живой route sample, check-in/photo,
   finish/result/history и открытие формы следующего рейда.
4. `offline-recovery.spec.ts` доказывает durable offline route/check-in/photo, reload без Background Sync,
   строгий прирост server route count, exact single check-in/credit/media и стабильные counts после reload.
5. Fixture write/inspect выполняются только при exact DB name `kabanda_e2e`, COMMENT marker и UUID run;
   runner не умеет create/drop DB и не обходит immutable result triggers.

Следующие сценарии остаются `Pending` и не могут отмечаться выполненными только по этим двум specs:

- invite/auth/join с отдельными участниками, handoff и account switch;
- lost-response/idempotency для всех команд, tenant/cache/media isolation;
- UI recovery для GPS stale/stop, queue stall, media failure и SW mismatch;
- log/artifact sensitive-field scan;
- exact row cleanup rehearsal. CI cleanup выполняется уничтожением внешнего marked disposable service.

Команды, run URLs, counts и hashes записываются в отчёт; фраза «CI зелёный» без exact run не считается
evidence.

## 2. Физическая PWA-матрица

Использовать `pwa-device-matrix.md`: реальный iPhone/WebKit и Android/Chromium, каждый в standalone и
browser mode. Полные navigator/lifecycle сценарии выполняются в standalone; browser mode проверяет
participant invite, auth, check-in, camera/share и offline recovery.

На обеих ОС обязателен отдельный 60–90-минутный screen-awake test с фактическими battery/storage/gap
значениями. Desktop emulation его не заменяет. Raw capability exports остаются restricted local.

## 3. Внутренний field ride

Состав: 4–6 участников, 10–20 км, 60–120 минут, installed PWA navigator и смесь iOS/Android participant
modes. До старта назначаются анонимные participant codes и человек, который ведёт evidence, но не помогает
с интерфейсом без явного запроса.

Обязательный сценарий:

1. Browser invite → auth → install guidance → standalone navigator readiness.
2. Создание, lobby и старт без ручной правки данных.
3. Обычный чекин пяти присутствующих и фотография.
4. Контролируемый временный offline-сегмент с durable route/check-in/photo.
5. Reload/relaunch после безопасной остановки и foreground replay без Background Sync.
6. Один navigator handoff и rejection прежней lease.
7. Service-worker update доступен во время рейда, отложен и активирован после завершения.
8. Finish с видимым pending inventory, один settled result, history и share/download fallback.
9. Организатор без помощи создаёт или планирует следующий рейд.

Не следует искусственно вызывать опасный low-GPS сценарий во время движения. Если он не возник естественно,
его автоматический/стационарный evidence помечается отдельно, без выдуманного field pass.

## 4. Закрытая альфа

Только после `GO` или явного `LIMITED GO WITH CONDITIONS` внутреннего рейда подключаются независимые
Кабанды. Общий лимит — не более 20 уникальных alpha users, включая внутренний рейд.

- Для каждой Кабанды фиксируются участники, устройства/modes, completed raids и следующий созданный рейд.
- После первого рейда собирается короткое интервью; повторный реально завершённый рейд считается retention,
  а только созданный следующий рейд — намерением, не retention.
- Доступен один ручной support channel. Записываются число обращений и фактические минуты помощи.
- Expansion останавливается при abort condition, превышении privacy/support границ или невозможности
  выполнить scoped rollback.

## Метрики и заранее фиксированные пороги

- `normal check-in time`: от нажатия основной кнопки до канонически принятого результата; median `<= 25 s`.
  Durable local acknowledgement для offline измеряется отдельно.
- `first-attempt rate`: accepted первой отправкой / все обычные eligible attempts; намеренные failure/fallback
  сценарии исключаются; порог `>= 80%`.
- `route loss`: durable local samples минус accepted, duplicate и explicit terminal rejection; unexplained `0`.
- `media loss`: каждый durable draft имеет accepted либо explicit terminal result; unexplained `0`.
- `battery`: duration, percent before/after, charging, Low Power/Battery Saver, screen/Wake Lock и heat.
- `storage`: bytes before/after и after scoped cleanup.
- `support burden`: `<= 2` requests и `<= 15` helper minutes на один completed raid.
- `manual data repair`: `0`.
- Пять representative participants отвечают на closing questions; минимум `4 из 5` готовы ехать снова.
- Организатор без developer help создаёт следующий рейд.

## Решение

### GO

Все автоматические и physical gates зелёные, thresholds выполнены, route/media unexplained loss равен нулю,
нет P0/P1 privacy/access/false-GPS инцидента и rollback однозначен.

### LIMITED GO WITH CONDITIONS

Safety, privacy и data integrity проходят, но существует ограничиваемая проблема конкретного device/mode,
явного fallback или support. В решении обязательны exact scope, срок, владелец и correction issue; аудитория
не расширяется за записанную границу.

### NO-GO

Любой abort condition, manual data repair, необъяснимая потеря данных, ложный GPS state, неприемлемый
navigator mode либо невозможность завершить core flow без разработчика. NO-GO не разрешает тихо менять
архитектуру или добавлять native wrapper.

## Scoped rollback и cleanup

1. Остановить onboarding и отозвать только alpha invites/sessions записанного alpha scope.
2. Отключить exact alpha artifact или вернуть записанный совместимый immutable artifact.
3. Удалить только поддерживаемые mutable DB rows, storage и browser resources с exact ownership из отчёта.
   Completed immutable result rows не обходить: для E2E уничтожить внешний disposable DB service только
   после буквальной проверки имени `kabanda_e2e` и COMMENT `kabanda-e2e-disposable-v1`. Для alpha cleanup
   использовать отдельный согласованный scoped-механизм; пока его нет, решение не может быть `GO`.
4. Сохранить permitted append-only incident evidence и hashes; raw restricted evidence удалить по
   согласованному retention window.
5. Проверить, что production/unrelated data не затронуты, и записать cleanup result в тот же отчёт.
