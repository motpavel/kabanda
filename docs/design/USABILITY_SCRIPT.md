# Kabanda VP usability script

Use the deployed or local HTTPS prototype on a physical phone. Do not explain where to tap. Read only the
scenario prompt, observe, and ask the closing questions.

## Session setup

- Participant code: anonymous `U1` through `U5`.
- Record device, OS, browser, browser/standalone mode and viewport.
- Ask whether the participant has previously seen Kabanda.
- Never record raw coordinates, email, private photos or auth tokens.

## Organizer scenario

Say: "Вы собираете друзей на вечернюю поездку. Создайте Кабанду и рейд, соберите участников, проверьте
готовность телефона, закройте ближайшую точку и завершите поездку. По пути интернет временно пропадёт."

Observe without prompting:

1. Time to create the raid.
2. Whether the participant can identify the navigator and readiness blockers.
3. Whether `Сохранено на телефоне` is mistaken for completion.
4. Time from opening the nearest point to confirming the team check-in.
5. Recovery from stale GPS and offline photo draft.
6. Whether pending operations are noticed before finish.
7. Whether the participant can start planning the next ride from the result.

## Ordinary participant scenario

Say: "Вам прислали приглашение в Кабанду. Войдите, вернитесь в приглашение, присоединитесь к рейду,
подтвердите чекин, добавьте фотографию и найдите результат поездки позже."

Observe without prompting:

1. Whether invite context survives auth.
2. Whether browser versus installed mode is understood.
3. Whether installation guidance feels relevant rather than forced.
4. Whether personal and team credit are distinguishable.
5. Whether local, sending, accepted and needs-action states are correctly explained.

## Closing questions

1. "Что приложение сейчас считает завершённым, а что только сохранено на телефоне?"
2. "Что бы вы сделали, если GPS перестал обновляться?"
3. "Почему навигатору может понадобиться установленное приложение?"
4. "Где вы найдёте итог прошлой поездки?"
5. "Что было непонятно или заставило остановиться?"

## Evidence table

| User | Role | Device/mode | Completed unaided | Check-in seconds | State model correct | Blocker | Change |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| U1 | | | | | | | |
| U2 | | | | | | | |
| U3 | | | | | | | |
| U4 | | | | | | | |
| U5 | | | | | | | |

## Acceptance

- Five users complete the assigned path without verbal guidance.
- Median normal check-in is at most 20 seconds in the prototype.
- All five can distinguish local, sending, accepted and needs-action states.
- No screen presents competing primary actions.
- Every observed blocker is either fixed or recorded with a deliberate VP decision.
