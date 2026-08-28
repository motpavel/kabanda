# Физическая матрица PWA

Статус: pending physical devices. Автоматические браузерные тесты не закрывают эту матрицу.

## Отдельно от code acceptance #35

- Unit/integration/browser tests могут закрыть DTO, authorization, lease fencing, duplicate replay,
  IndexedDB durability, truth-state transitions и service-worker update gate, но не доказывают пригодность
  PWA для реальной 60–90-минутной поездки.
- Field acceptance #35 остаётся открытым до завершения сценария `Screen-awake + Wake Lock` на обоих
  обязательных устройствах, а также замеров lock/background gaps, battery и storage.
- После code acceptance тот же 60–90-минутный маршрут повторяется в настоящем active-raid recorder #35:
  Capability Lab даёт platform evidence, но один не закрывает end-to-end lease/outbox/replay acceptance.
- Пока IOS-1 и AND-1 имеют статус `Pending`, нельзя заявлять поддержку background/lock-screen GPS.
  Допустима только экспериментальная формулировка `standalone + screen awake + Wake Lock при наличии`.

## Подготовка

1. Открыть HTTPS URL Capability Lab.
2. Установить PWA и запустить standalone.
3. Ввести точное устройство, OS/browser version и сценарий в названии сессии.
4. Разрешить precise location; зафиксировать выбор permission.
5. Запросить persistent storage и Wake Lock.
6. Начать GPS, пройти/проехать известный маршрут.
7. После каждого сценария скачать JSON + GeoJSON и приложить к #30.
8. Записать battery before/after, storage usage, температуру/нагрев и помощь разработчика.

## Обязательные устройства

| ID | Устройство | OS | Browser engine | Display mode | Owner | Статус |
|---|---|---|---|---|---|---|
| IOS-1 | Требуется реальный iPhone | TBD | WebKit | standalone | Павел | Pending |
| AND-1 | Требуется реальный Android | TBD | Chromium | standalone | Павел | Pending |

## Сценарии для каждого устройства

| Сценарий | Длительность | Ожидаемое безопасное поведение | IOS-1 | AND-1 |
|---|---:|---|---|---|
| Установка и standalone launch | 5 мин | display mode standalone, сессия сохраняется | Pending | Pending |
| Foreground GPS | 15 мин | свежие samples, точность и gaps в evidence | Pending | Pending |
| Screen-awake + Wake Lock | 60–90 мин | пригодный маршрут, Wake Lock release виден | Pending | Pending |
| Экран заблокирован | 10 мин | фактический gap измерен, UI после resume не лжёт | Pending | Pending |
| Другое приложение на foreground | 10 мин | suspension/gap измерен и объяснён | Pending | Pending |
| Offline во время GPS | 30 мин | samples остаются в IndexedDB | Pending | Pending |
| Reload/relaunch | 5 мин | та же сессия и ранее записанные samples доступны | Pending | Pending |
| Low Power/Battery Saver | 15 мин | результат и ограничения записаны | Pending | Pending |
| Permission revoke/restore | 5 мин | ошибка видна, recovery понятен | Pending | Pending |
| Service-worker update | 10 мин | нет принудительного reload во время GPS | Pending | Pending |
| Camera/file capture | 5 мин | photo input работает или имеет понятный fallback | Pending | Pending |
| Offline check-in replay | 10 мин | свежий replay принимается, просроченный честно требует ручной проверки | Pending | Pending |
| Offline photo upload | 10 мин | draft переживает reload, после online появляется один accepted media | Pending | Pending |
| Five-person check-in | 10 мин | claims видят только выбранные участники, credit не дублируется | Pending | Pending |
| Web Share/download | 5 мин | evidence передаётся или скачивается | Pending | Pending |
| Finish после offline-очереди | 10 мин | очередь видна, foreground replay не теряется, partial требует явного подтверждения | Pending | Pending |
| Finalizing/reload | 5 мин | deadline и pending берутся с сервера, итог появляется один раз | Pending | Pending |
| Storage pressure/clear site data | 10 мин | потеря/восстановление описаны без ложных обещаний | Pending | Pending |

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

## Решение

- [ ] `GO PWA`
- [ ] `LIMITED GO WITH CONDITIONS`
- [ ] `NO-GO`

Решение нельзя выбирать до приложенного evidence с обоих обязательных устройств.
