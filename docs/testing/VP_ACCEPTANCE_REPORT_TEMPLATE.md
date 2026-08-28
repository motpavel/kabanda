# VP acceptance report — template

Скопировать этот файл для конкретного acceptance run и заполнять по ходу проверки. Не удалять failed rows:
исправление добавляется новой строкой с новым attempt и ссылкой на исходную ошибку.

## Статус

- E2E_RUN_ID: `TBD` — UUID, отдельный от имени и COMMENT database
- Date/timezone: `TBD`
- Evidence owner: `TBD`
- Reviewer: `TBD`
- Decision owner: Павел
- Phase: `PREP | AUTOMATION | DEVICE | FIELD | ALPHA | DECISION | CLEANUP`
- Decision: `PENDING | GO | LIMITED GO WITH CONDITIONS | NO-GO`

## Exact artifact и data scope

| Identifier | Exact value/hash | Evidence |
|---|---|---|
| Source base | TBD | |
| Source head | TBD | |
| Git tree | TBD | |
| PWA/client build | TBD | |
| Manifest version | TBD | |
| Service-worker/cache version | TBD | |
| API build | TBD | |
| DB schema/migration set hash | TBD | |
| Synthetic fixture SHA-256 | TBD | |
| E2E_RUN_ID | TBD UUID | row/resource ownership |
| E2E DB name | exact `kabanda_e2e` | dedicated disposable service |
| E2E DB COMMENT | `kabanda-e2e-disposable-v1` | immutable exact marker |
| E2E DB credential | loopback, exact user `kabanda_e2e`, non-empty password, no privileged role flags | guarded separate login |
| Alpha DB/storage marker | TBD | exact scoped prefix only |
| Previous compatible rollback artifact | TBD | |
| Restricted raw evidence location | TBD | local, access-bounded |
| Restricted evidence SHA-256 manifest | TBD | public-safe hash only |

Public GitHub evidence contains only hashes, aggregates and sanitized images. Raw JSON/GeoJSON/routes,
original private media, tokens and personal data remain restricted local and are never pasted into issues.

## Авторизация и безопасность

- [ ] Exact artifact and alpha scope authorized.
- [ ] Devices, route and maximum 20 alpha users approved.
- [ ] Every participant gave location/photo/privacy-safe diagnostics consent.
- [ ] Consent withdrawal and retention procedure explained.
- [ ] No phone interaction while moving; stopped-only actions explained.
- [ ] Navigator understands screen-awake/Wake Lock and background limitations.
- [ ] Abort owner and scoped rollback owner assigned.

Notes without names, coordinates or private media: `TBD`

## Автоматический gate

| Attempt | Exact command/run | Head/fixture hash | Result | Counts/latency | Failure/correction |
|---:|---|---|---|---|---|
| 1 | TBD | TBD | Pending | | |

Implemented critical subset (must be green for exact head):

- [ ] clean migrations and guarded disposable fixture seed/inspect;
- [ ] owner happy path through result/history/next-raid form;
- [ ] offline/reload/replay without Background Sync;
- [ ] strict route count growth and exact single check-in/credit/media after reload;
- [ ] external marked disposable DB service destroyed after the run.

Pending extension gates (do not infer Pass from the two current specs):

- [ ] invite/auth/join, handoff and account switch;
- [ ] lost-response/idempotency coverage beyond the critical replay path;
- [ ] tenant/cache/media isolation;
- [ ] UI recovery for GPS stale/stop, queue stall, media failure and SW mismatch;
- [ ] sensitive-field scan;
- [ ] exact row cleanup mechanism that preserves immutable result invariants.

## Physical device matrix summary

Полные строки и append-only failures находятся в `pwa-device-matrix.md`.

| Mode ID | Exact device/OS/browser | Matrix status | 60–90 min result | Restricted evidence hash | Limitation/issue |
|---|---|---|---|---|---|
| IOS-S | TBD | Pending | Pending | | |
| IOS-B | TBD | Pending | N/A participant mode | | |
| AND-S | TBD | Pending | Pending | | |
| AND-B | TBD | Pending | N/A participant mode | | |

### Battery, storage и lifecycle

| Attempt | Mode | Minutes | Battery before/after | Charging/saver | Storage before/after/cleanup | Sample gaps/stale | Wake Lock/heat | Result |
|---:|---|---:|---|---|---|---|---|---|
| 1 | TBD | | | | | | | Pending |

## Internal field ride

- Date/weather summary: `TBD`
- Anonymous participants: `TBD` — required 4–6
- Planned/actual duration: `TBD` — required 60–120 minutes
- Planned/actual distance bucket: `TBD` — target 10–20 km; no route coordinates
- Navigator mode/device: `TBD`
- iOS/Android participant modes: `TBD`
- Controlled offline segment: `TBD`
- Handoff: `TBD`
- Deferred SW update: `TBD`
- Completed without developer data repair: `Pending`
- Result/history/share opened: `Pending`
- Next raid created unaided: `Pending`

### Field scenario attempts — append-only

| Attempt | Scenario | Expected | Actual aggregate | Result | Operation/build ID | Failure/correction |
|---:|---|---|---|---|---|---|
| 1 | TBD | TBD | TBD | Pending | | |

### Check-in observations

`Normal` excludes deliberately induced GPS/fallback failures. Time ends at canonical acceptance; offline local
acknowledgement is recorded separately.

| Check-in ID | Normal/failure | Duration seconds | First attempt | Local ack seconds | Canonical outcome | Help requested | Notes/code only |
|---|---|---:|---|---:|---|---|---|
| C1 | | | | | | | |

- Median normal duration: `TBD` / threshold `<=25 s`
- First-attempt rate: `TBD/TBD = TBD%` / threshold `>=80%`

### Route/check-in/media reconciliation

| Kind | Durable local | Accepted | Duplicate | Explicit terminal | Unexplained loss | Result |
|---|---:|---:|---:|---:|---:|---|
| Route samples | | | | | | Pending |
| Check-ins | | | | | | Pending |
| Media drafts | | | | | | Pending |

Required unexplained loss: `0`. Do not include coordinates, polylines, photo bytes or private URLs.

## Closed alpha — maximum 20 unique users

| Anonymous user | Kabanda code | Role | Device/mode | Completed raids | Next raid created/joined | Support requests | Support minutes | Interview |
|---|---|---|---|---:|---|---:|---:|---|
| U1 | | | | | | | | |

- Unique alpha users: `TBD/20`
- Completed rides: `TBD`
- Another completed ride (retention, not intent): `TBD`
- Support per completed ride: `TBD requests / TBD minutes`
- Threshold: `<=2 requests`, `<=15 minutes`, manual data repair `0`

## Representative interviews

Use the five closing questions from `../design/USABILITY_SCRIPT.md`. Store bounded themes, not transcripts,
names, coordinates or private media.

| User | Completed unaided | State model understood | Ready to ride again | Main bounded theme | Correction issue |
|---|---|---|---|---|---|
| U1 | | | | | |
| U2 | | | | | |
| U3 | | | | | |
| U4 | | | | | |
| U5 | | | | | |

- Ready again: `TBD/5` / threshold `>=4/5`
- Organizer created next raid without developer help: `Pending`

## Known issues and failure history — append-only

| Recorded at | Attempt/build | Severity | Observation | Safe constraint | Owner | Correction issue/status |
|---|---|---|---|---|---|---|
| TBD | | | | | | |

## Решение

Select exactly one and explain against the pre-recorded thresholds.

- [ ] `GO`
- [ ] `LIMITED GO WITH CONDITIONS`
- [ ] `NO-GO`

Rationale: `TBD`

For LIMITED GO: exact allowed devices/modes/users, condition, owner and issue: `TBD`

For NO-GO: abort trigger and required architecture/product review: `TBD`

Decision owner/date: `TBD`

## Scoped rollback и cleanup

| Resource | Exact ownership/marker | Planned action | Result/evidence | Unrelated data checked |
|---|---|---|---|---|
| E2E mutable browser resources | exact `E2E_RUN_ID` UUID/browser context | close exact context; no broad browser cleanup | Pending | Pending |
| E2E rows with immutable completed result | guarded ownership anchored at exact synthetic user | no trigger bypass; cleanup is service destruction | Pending | Pending |
| Dedicated E2E DB service | exact name `kabanda_e2e`; COMMENT `kabanda-e2e-disposable-v1` | destroy externally only after both exact checks | Pending | Pending |
| Alpha sessions/invites | TBD | revoke exact run scope | Pending | Pending |
| Alpha storage/data | TBD | remove/retain by consent policy | Pending | Pending |
| Restricted raw evidence | TBD | delete at retention deadline | Pending | Pending |

- Cleanup performed by/date: `TBD`
- Manual repair count: `TBD` / required `0`
- Production/unrelated resources touched: `TBD` / required `No`
- Append-only incident evidence retained under approved scope: `TBD`
