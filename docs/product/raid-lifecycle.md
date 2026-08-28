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
- Handoff создаёт явную точку cutover. Старый lease больше не принимает route batches.
- Потеря связи не передаёт роль автоматически. PWA показывает stale GPS и предлагает pause или явный handoff.

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

## Локальная операция PWA

```text
pending -> sending -> accepted
              |       
              +-> retryable -> sending
              +-> rejected
```

- Outbox запись содержит schema version, operation ID, actor ID, Kabanda ID, raid ID и captured time.
- `accepted` означает серверный receipt, а не успешный fetch без разбора ответа.
- Logout/account switch блокирует replay операций другой identity.
- Background Sync ускоряет replay, но запуск приложения, возврат в foreground и событие online обязаны инициировать его независимо.

## Пауза, завершение и восстановление

- Pause/finish требуют явного подтверждения и актуальной версии рейда.
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
