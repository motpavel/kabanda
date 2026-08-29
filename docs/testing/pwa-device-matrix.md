# Физическая матрица PWA

Статус: pending physical devices. Автоматические браузерные тесты не закрывают эту матрицу.

## Отдельно от code acceptance #38

- Unit/integration/browser tests могут закрыть DTO, authorization, lease fencing, duplicate replay,
  IndexedDB durability, truth-state transitions и service-worker update gate, но не доказывают пригодность
  PWA для реальной 60–90-минутной поездки.
- Field acceptance #38 остаётся открытым до завершения сценария `Screen-awake + Wake Lock` на обоих
  обязательных устройствах, а также замеров lock/background gaps, battery и storage.
- После code acceptance тот же 60–90-минутный маршрут повторяется в настоящем active-raid recorder #38:
  Capability Lab даёт platform evidence, но один не закрывает end-to-end lease/outbox/replay acceptance.
- Пока IOS-S и AND-S имеют статус `Pending`, нельзя заявлять поддержку background/lock-screen GPS.
  Допустима только экспериментальная формулировка `standalone + screen awake + Wake Lock при наличии`.

Матрица append-only: failed attempt не заменяется новым `Pass`. Повтор добавляется отдельной строкой или
ссылкой на новый attempt/correction issue.

## Подготовка

1. Открыть HTTPS URL Capability Lab.
2. Установить PWA и запустить standalone.
3. Ввести точное устройство, OS/browser version и сценарий в названии сессии.
4. Разрешить precise location; зафиксировать выбор permission.
5. Запросить persistent storage и Wake Lock.
6. Начать GPS, пройти/проехать известный маршрут.
7. После каждого сценария сохранить JSON + GeoJSON только в restricted local storage и посчитать SHA-256.
8. В GitHub приложить только hash, агрегаты и sanitized изображения без координат/route/private media.
9. Записать battery before/after, storage usage, температуру/нагрев и помощь разработчика.
10. Для fixture-backed evidence отдельно записать UUID `E2E_RUN_ID`, exact DB name `kabanda_e2e` и
    immutable DB COMMENT `kabanda-e2e-disposable-v1`; не объединять их в один marker.

## Обязательные устройства

| ID | Устройство | OS | Browser engine | Display mode | Роль проверки | Owner | Статус |
|---|---|---|---|---|---|---|---|
| IOS-S | Требуется реальный iPhone | TBD | WebKit | standalone | navigator + participant | Павел | Pending |
| IOS-B | Тот же или эквивалентный iPhone | TBD | WebKit | browser | participant | Павел | Pending |
| AND-S | Требуется реальный Android | TBD | Chromium | standalone | navigator + participant | Павел | Pending |
| AND-B | Тот же или эквивалентный Android | TBD | Chromium | browser | participant | Павел | Pending |

## Сценарии для каждого устройства

| Сценарий | Длительность | Ожидаемое безопасное поведение | IOS-S | IOS-B | AND-S | AND-B |
|---|---:|---|---|---|---|---|
| Установка и standalone launch | 5 мин | display mode standalone, сессия сохраняется | Pending | N/A | Pending | N/A |
| Browser invite/auth/deep-link | 5 мин | continuation сохраняется, install не навязывается participant | N/A | Pending | N/A | Pending |
| Foreground GPS | 15 мин | свежие samples, точность и gaps в evidence | Pending | N/A | Pending | N/A |
| Screen-awake + Wake Lock | 60–90 мин | пригодный маршрут, Wake Lock release виден | Pending | N/A | Pending | N/A |
| Экран заблокирован | 10 мин | фактический gap измерен, UI после resume не лжёт | Pending | N/A | Pending | N/A |
| Другое приложение на foreground | 10 мин | suspension/gap измерен и объяснён | Pending | N/A | Pending | N/A |
| Offline во время GPS | 30 мин | samples остаются в IndexedDB | Pending | N/A | Pending | N/A |
| Reload/relaunch | 5 мин | та же сессия и ранее записанные samples доступны | Pending | Pending | Pending | Pending |
| Low Power/Battery Saver | 15 мин | результат и ограничения записаны | Pending | N/A | Pending | N/A |
| Permission revoke/restore | 5 мин | ошибка видна, recovery понятен | Pending | Pending | Pending | Pending |
| Service-worker update | 10 мин | нет принудительного reload во время GPS | Pending | N/A | Pending | N/A |
| Camera/file capture | 5 мин | photo input работает или имеет понятный fallback | Pending | Pending | Pending | Pending |
| Offline check-in replay | 10 мин | свежий replay принимается, просроченный честно требует ручной проверки | Pending | Pending | Pending | Pending |
| Offline photo upload | 10 мин | draft переживает reload, после online появляется один accepted media | Pending | Pending | Pending | Pending |
| Five-person check-in | 10 мин | claims видят только выбранные участники, credit не дублируется | Pending | Pending | Pending | Pending |
| Web Share/download | 5 мин | evidence передаётся или скачивается | Pending | Pending | Pending | Pending |
| Finish после offline-очереди | 10 мин | очередь видна, replay не теряется, partial подтверждён явно | Pending | N/A | Pending | N/A |
| Finalizing/reload | 5 мин | deadline и pending с сервера, итог появляется один раз | Pending | N/A | Pending | N/A |
| Storage pressure/clear site data | 10 мин | потеря/восстановление описаны без ложных обещаний | Pending | Pending | Pending | Pending |

## Метрики

- route duration и sample count;
- max/median gap между samples;
- accuracy median/p95;
- количество stale transitions;
- Wake Lock acquire/release/failure;
- battery percentage before/after;
- storage usage before/after;
- reload/relaunch recovery;
- camera/share result;
- время от primary action до durable local receipt;
- время offline photo от reconnect до accepted gallery item;
- количество duplicate credits/media после reload и повторного нажатия;
- время от online finish до immutable result и причины partial finalization;
- app-caused confusion и developer help requests.

Для каждого attempt записываются exact artifact/fixture hashes, UUID `E2E_RUN_ID`, device/OS/browser,
restricted evidence hash, expected/actual result и correction issue. DB name, immutable DB COMMENT и run UUID
остаются разными полями. Raw route или private media в эту таблицу не попадают.

## Решение

- [ ] `GO PWA`
- [ ] `LIMITED GO WITH CONDITIONS`
- [ ] `NO-GO`

Решение нельзя выбирать до приложенного evidence с обоих обязательных устройств.
