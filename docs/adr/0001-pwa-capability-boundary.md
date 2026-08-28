# ADR-0001: PWA capability boundary для навигатора

- Статус: Proposed, blocked on physical device evidence
- Issue: #30
- Decision owner: Павел

## Контекст

КАБАНДА проверяет совместный городской велорейд на аудитории до 20 человек. PWA выбрана ради скорости поставки и одного mobile-first клиента, но основной цикл зависит от реального поведения геолокации, lifecycle, IndexedDB, service worker, камеры и sharing на iOS/Android.

Web Geolocation не является обещанием непрерывной фоновой записи. Service worker не имеет права считаться GPS-демоном. Поэтому архитектура утверждается только после физического теста.

## Предлагаемое решение

Условно принять устанавливаемую React/Vite PWA со следующим navigator mode:

1. Навигатор открывает установленную PWA в standalone.
2. GPS записывается только видимой страницей через `watchPosition`.
3. При наличии PWA запрашивает Screen Wake Lock и показывает его фактическое состояние.
4. Каждый sample сохраняется в IndexedDB до сетевой отправки.
5. Если свежего sample нет 15 секунд, интерфейс переходит в `stale`; порог уточняется полевым тестом.
6. Background Sync является optional acceleration; deterministic replay выполняется также при startup, resume и online.
7. Service-worker update не активируется с принудительным reload во время записи.
8. Блокировка экрана и background suspension измеряются, но не считаются поддержанными без evidence.

## GO criteria

- PWA устанавливается и открывается standalone на выбранных iPhone и Android.
- Screen-awake сценарий записывает пригодный маршрут 60–90 минут без необъяснимой потери сегментов.
- PWA обнаруживает suspension/stale GPS и не показывает ложное активное состояние.
- IndexedDB samples и lifecycle ledger переживают reload/process restart.
- App shell открывается offline после одного успешного online-запуска.
- Service-worker update не прерывает активный тест.
- Камера/file capture и Web Share имеют рабочий fallback.
- Расход батареи и storage приемлем для одного рейда и зафиксирован числами.
- Тестировщик понимает supported navigator mode без помощи разработчика.

## NO-GO / architecture review triggers

- screen-awake PWA не записывает пригодный маршрут;
- ОС регулярно приостанавливает видимую standalone PWA без обнаружимого recovery;
- Wake Lock недоступен или системно отзывается так, что режим неприемлем пользователю;
- route samples теряются при обычном reload/relaunch;
- батарея или нагрев делают 60–90 минут неприемлемыми;
- навигатор не готов держать телефон установленным с активным экраном;
- продукт требует гарантированного background/lock-screen GPS.

NO-GO останавливает #31–#38 до отдельного owner-approved ADR о платформе. Он не разрешает тихо добавить Capacitor, React Native или native wrapper.

## Evidence

Capability Lab экспортирует JSON и GeoJSON. Результаты вносятся в `docs/testing/pwa-device-matrix.md` без улучшения или удаления неудачных сценариев.

## Final decision

Ожидает физической матрицы. Допустимые значения: `GO PWA`, `LIMITED GO WITH CONDITIONS`, `NO-GO`.

