# Жизненный цикл рейда VP

Статус: proposed для VP #29. Визуальный UX утверждается отдельно в #31.

Это целевой lifecycle всего VP. Delivery #34 материализует создание, планирование, lobby, старт,
pause/resume и cancel; `finalizing/completed`, participant leave/cutoff и связанные команды входят в #37,
когда появятся канонический полевой outbox и правила завершения. Наличие состояния в схеме #34 не означает
публикацию преждевременного HTTP-перехода.

## Канонические состояния рейда

```text
draft -> planned -> lobby -> active <-> paused -> finalizing -> completed
   |        |         |         |             |
   +--------+---------+---------+-------------+-> cancelled
```

- `draft`: канонический серверный черновик; его можно безопасно продолжить после reload.
- `planned`: рейд создан, но приглашения ещё можно менять без влияния на поездку.
- `lobby`: приглашения отправлены, участники принимают или отклоняют участие, навигатор проходит readiness.
- `active`: сервер подтвердил один старт и одну действующую роль навигатора.
- `paused`: маршрут не начисляет время и дистанцию; чекин недоступен.
- `finalizing`: новые действия запрещены, клиент досылает уже созданные offline-операции.
- `completed`: канонический результат зафиксирован; изменения возможны только отдельной audited correction.
- `cancelled`: рейд не даёт прогресса; уже принятые технические операции сохраняются в аудите без начисления.

Переходы выполняются named commands с `operationId`, actor, expected version и captured time. Универсального PATCH состояния нет. Receipt сохраняет fingerprint запроса и неизменяемый bounded snapshot канонического ответа; повторная доставка не пересчитывает ответ из более нового состояния рейда.

## Участник

```text
invited -> accepted -> ready -> active -> left
    |          |
    +-> declined
               +-> removed
```

- После перехода рейда в `active` новые участники в VP не присоединяются.
- Участник, вышедший раньше, сохраняет только credit, принятый до `leftAt`.
- Removed/left membership немедленно теряет доступ к новым приватным данным, независимо от локального cache.
- Owner управляет Кабандой; navigator владеет только записью маршрута текущего рейда.

## Навигатор

- Одновременно существует один server-issued navigator lease.
- Старт невозможен без readiness навигатора по ADR-0001.
- Для старта нужен свежий server-owned readiness report текущего навигатора и текущей версии lobby.
  Смена навигатора или версии делает старый report неприменимым; неподтверждённый background GPS не
  считается зелёной capability.
- Каждый lease принадлежит одной монотонной generation. Canonical server time, а не client `capturedAt`,
  определяет cutover и право batch на ingestion.
- Handoff создаёт явную server-time точку cutover и fail-closed закрывает старую generation. Старый lease
  больше не принимает route batches, даже если клиент пометил samples временем до handoff.
- Recover — явный fenced takeover, а не автоматическое следствие timeout/offline. Он закрывает прежнюю
  generation и требует новый acquire; прежний tab/device не может продолжить canonical upload.
- Потеря связи не передаёт роль автоматически. PWA показывает stale GPS и предлагает pause или явный handoff.

## Local recorder #35

```text
idle -> starting -> recording
          |          +-> stale -> starting
          |          +-> paused -> starting
          |          +-> stopped
          +----------+-> error
```

- Это runtime truth PWA, а не второй server raid lifecycle.
- `recording` допустим только для canonical navigator с active lease той же generation, живым
  `watchPosition`, granted permission и свежим sample, durable-записанным в identity-bound IndexedDB.
- Временный marker, работающий timer или наличие `watchId` без свежего durable sample не являются
  доказательством записи. После ADR-порога без sample состояние становится `stale`.
- Permission revoke, page lifecycle warning, IndexedDB/quota failure, incompatible schema и lease fencing
  переводят recorder из зелёного состояния до recovery.
- Service worker не записывает GPS и не может переводить recorder в `recording`.

## Чекин

```text
draft -> evidence_pending -> submitted -> accepted
                                |           
                                +-> rejected
                                +-> needs_review -> accepted/rejected
```

- Чекин создаётся только явным действием пользователя.
- Сервер сам вычисляет расстояние до канонической точки по свежему evidence.
- Один `operationId` создаёт не более одного канонического результата.
- Повторное посещение остаётся в истории, но не увеличивает unique points.
- Organizer attestation и manual fallback отличаются от обычного GPS-чекина в данных и интерфейсе.
- Геолокация снимается one-shot в момент действия и не берётся из recorder cache.
- Поздний первый offline replay сохраняет evidence как `needs_manual_verification`, но не получает credit.
- Credit неизменяем и уникален для участника и snapshot-точки рейда; новые evidence и corrections
  добавляются отдельно, а не переписывают историю.
- Self-claim подтверждает только сам участник. Manual fallback требует accepted media и другого активного
  verifier; self-verification не может заменить серверную проверку расстояния.

## Локальная операция PWA

```text
local -> pending -> sending -> accepted
              |       
              +-> retryable -> sending
              +-> rejected/needs_action
```

- Outbox запись содержит schema version, operation ID, actor ID, Kabanda ID, raid ID и captured time.
- `accepted` означает серверный receipt, а не успешный fetch без разбора ответа.
- Logout/account switch блокирует replay операций другой identity.
- Background Sync ускоряет replay, но запуск приложения, возврат в foreground и событие online обязаны инициировать его независимо.
- `pending` показывается только после успешного Dexie commit. Запись `sending` имеет bounded `claimUntil`;
  после crash/reload просроченный claim возвращается в retryable. Две вкладки используют sender lease/fence.
- Photo draft сохраняет stable `clientDraftId`, SHA и Blob, но никогда не сохраняет upload capability.
  Истёкший intent создаётся заново с новым operation ID, не меняя пользовательский draft или bytes.
- Route operation несёт lease ID и generation. Offline replay разрешён только пока на сервере активен тот
  же lease того же actor; pause/handoff/recover fence-ят прежнюю очередь.
- Fenced route operation не переписывается под новую generation. Она получает terminal rejection/
  `needs_action` и сохраняется локально как диагностическое evidence до явной cleanup policy.

## Пауза, завершение и восстановление

- Pause/finish требуют явного подтверждения и актуальной версии рейда.
- Pause fail-closed фиксирует server-time cutover и закрывает активную route generation. Pending batches
  старой generation после pause не становятся canonical задним числом.
- Resume создаёт новую route generation через lease acquire, даже если navigator не изменился. Старый
  sequence/idempotency namespace не переиспользуется.
- Handoff/recover также закрывают прежнюю generation до выдачи новой; клиентское время не определяет
  границу и не может обойти fencing.
- Offline finish сохраняется как pending command. После reconnect сервер применяет или детерминированно отклоняет его по текущему состоянию.
- `finalizing` ждёт bounded набор ранее созданных route/check-in/media операций и показывает, что итог ещё собирается.
- После `completed` рейд не открывается заново. Исправления имеют отдельную audit lineage.
- Reload/process kill/service-worker update читают серверный raid state и совместимый identity-bound outbox; UI не угадывает состояние по старому client flag.

## Инварианты VP

1. Один рейд имеет не более одного канонического старта, завершения и активного navigator lease.
2. Client totals, distance, actor, membership и final status не являются доверенным источником истины.
3. Service worker не записывает GPS и не владеет состоянием рейда.
4. Отсутствие свежего sample переводит recorder в `stale`; зелёное состояние не сохраняется бессрочно.
5. Повторная доставка operation не создаёт повторный credit, media или distance.
6. Данные до join и после leave не начисляются участнику.
7. Private route/media никогда не попадают в общий app-shell cache.
8. Pause, handoff и recover не доверяют client clock и необратимо fence-ят прежнюю route generation.
9. Local sample становится `saved` только после IndexedDB commit, а canonical — только после server receipt.
10. Поздняя геолокация и pending claim/fallback не создают canonical credit.
11. Один участник получает не более одного credit за одну snapshot-точку рейда независимо от replay.
