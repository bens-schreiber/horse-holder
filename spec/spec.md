# Horse Holder Protocol — v1

A vendor-neutral HTTP protocol for **pre-flight budget enforcement**: setting spending
limits and drawing against them _before_ a metered operation happens.

This document specifies the wire protocol. It does not specify storage, deployment, or how
credentials are issued and verified; for authentication, it fixes only where a credential
travels on the wire (§9). Any server implementing the endpoints and semantics below is a
conforming Horse Holder implementation.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted as
described in RFC 2119.

---

## 1. Concepts

**Scope** — The authorization boundary. Every request resolves to exactly one scope,
determined by the server from the request's credentials and never named by the caller
(see §9). A scope isolates budgets completely: two scopes may use identical budget IDs
without interacting. For an unauthenticated single-user self-hosted deployment, there is
exactly one implicit scope, and every request resolves to it.

**Tenant** — An optional, caller-defined subdivision within a scope, sent per-request.
Used to give each of _your_ end users their own copy of the same budget.
Tenant strings are opaque to the server.

**Group** — A caller-defined atomicity domain within a `(scope, tenant)` pair, sent
per-request in the REQUIRED `hh-group` header. Budgets in the same group can be drawn
together atomically; budgets in different groups cannot be drawn together at all.

**Budget** — A named allowance within a `(scope, tenant, group)` triple. Identified by a
caller-defined string ID.

**Budget key** — The tuple `(scope, tenant, group, id)`. This is the _complete_ identity
of a budget. Implementations MUST derive storage keys from all four components. Deriving
storage identity from `id` alone is a critical isolation defect: two unrelated callers
who both name a budget `monthly-ops` would share and drain the same allowance.

**Definition** — A budget's configuration: its limit, renewal rule, and warning
thresholds. Sent inline with every draw (§3).

**Usage** — The amount consumed within the current period, including amounts held by
open reservations.

**Reservation** — A time-bounded hold on capacity, later finalized (`commit`) or
returned (`release`).

**Draw** — A request that decreases available capacity: a charge or a reserve.

### 1.1 Identifier rules

Budget IDs, tenant strings, and group strings MUST match `[A-Za-z0-9_.-]{1,128}`. A
tenant MAY additionally be the empty string (see below); a budget ID and a group MUST NOT
be.

This restriction exists to make composite key derivation safe. Implementations typically
build a storage key by joining the four components with a delimiter. If identifiers may
contain arbitrary characters, a caller can forge collisions across that delimiter: with a
`::` separator, tenant `a::b` + budget `c` derives the same key as tenant `a` + budget
`b::c`. That is cross-tenant budget access obtained by naming alone — the isolation
failure §1 warns about, reintroduced through the mechanism meant to prevent it.

Implementations MUST reject non-conforming identifiers with `400`. Implementations using a
derivation that is injective regardless of content (length-prefixed encoding, or hashing
each component separately) SHOULD still enforce the charset, so that budget keys remain
portable between implementations.

**Absent versus empty tenant.** An absent `hh-tenant` header and an `hh-tenant` header
whose value is the empty string identify **different** budgets. Absent means the scope's
default tenant; empty is an ordinary tenant that happens to be named `""`.
Implementations MUST distinguish these two cases. This requires care: many HTTP
frameworks return an empty string for a missing header, collapsing the distinction
silently. Implementations MUST check for header presence explicitly rather than testing
the retrieved value for emptiness.

### 1.2 Groups

A group is the unit of atomicity. Because the group travels in a single request header, a
draw cannot span groups — there is no way to express one. All-or-nothing (§8) therefore
holds unconditionally for every draw the protocol can represent.

**Choosing groups.** Budgets drawn together MUST share a group. In the common case a
single R2 write draws from an operation-count budget and a byte-count budget at once, so
those two belong together. Budgets never drawn in the same request — an email quota and a
storage quota, say — can be separated, which lets their draws proceed in parallel and
independently.

**Groups are mandatory.** `hh-group` MUST be present on every request. A request omitting
it MUST be rejected with `400`. There is no default.

A default group would pool every budget in a scope-tenant pair into one atomicity domain,
so unrelated subsystems — an email quota and a storage quota with nothing to do with one
another — would serialize against each other through a single transactional unit. Callers
would inherit that contention without ever choosing it, and would experience it as
unrelated operations mysteriously blocking one another under load. Requiring the header
moves the decision to the call site, where the caller knows which budgets actually belong
together.

**Groups are part of identity, not configuration.** Because the group is a component of
the budget key, drawing against budget `x` under group `a` and under group `b` addresses
**two independent budgets with separate usage**. This is unlike `limit` or `renewal`,
which reconcile onto an existing budget (§3.1).

The practical consequence is that a group is effectively immutable: changing the group a
budget is drawn under does not move it; it silently starts a fresh budget at zero usage.
Callers MUST treat a budget's group as fixed once chosen. Implementations MAY maintain a
scope-level index of budget IDs to their groups and reject a mismatch with `409`
`budget_group_conflict`; this is OPTIONAL because such an index must be consulted on every
draw, which reintroduces exactly the shared bottleneck groups exist to remove.

---

## 2. Transport and conventions

- All endpoints are rooted at an implementation-defined base URL plus `/v1`.
- Request and response bodies are `application/json; charset=utf-8`.
- Header names are lowercase and hyphenated.
- Timestamps are RFC 3339 / ISO 8601 in UTC, e.g. `2026-08-15T00:00:00Z`.
- Amounts are JSON numbers. They MUST be finite and MUST NOT be negative. Implementations
  MUST support at least 53-bit integer precision. Callers SHOULD use integers in the
  smallest meaningful unit (bytes, operation counts, hundredths of a cent) rather than
  floats, to avoid accumulated rounding error across many small draws.

### Headers

| Header              | Direction | Required                                 | Meaning                                                                        |
| ------------------- | --------- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| `authorization`     | request   | when the server requires credentials     | The caller's credential. Scheme is implementation-defined. See §9.             |
| `idempotency-key`   | request   | on `POST /v1/charge`, `POST /v1/reserve` | Deduplication key. See §7.                                                     |
| `hh-tenant`         | request   | no                                       | Tenant for this request. Absent means the scope's default tenant.              |
| `hh-group`          | request   | yes                                      | Atomicity domain for this request. No default.                                 |
| `hh-reservation-id` | request   | on `/v1/commit`, `/v1/release`           | Identifies the reservation being settled.                                      |
| `hh-ttl-seconds`    | request   | no                                       | Reservation lifetime. `POST /v1/reserve` only.                                 |
| `retry-after`       | response  | on `402`                                 | Standard HTTP header. Seconds until the earliest renewal among failed budgets. |
| `www-authenticate`  | response  | no                                       | Standard HTTP header. SHOULD accompany `401`. See §9.                          |

### Route shape

Every endpoint is a **static path**. No path parameters, no templating: all resource
identity travels in headers. Request bodies carry amounts; headers carry identity and
control.

`hh-tenant` and `hh-group` fully determine which storage unit a request touches, so an
implementation can route to that unit from headers alone, before reading or parsing the
body.

---

## 3. The inline definition model

Budget definitions are sent **inline with every draw**. There is no required
"create budget first" round trip. A draw against a budget that does not yet exist
creates it from the definition in that request.

This makes budgets fully declarative: the caller's code is the source of truth for
configuration, and the server reconciles toward it. A caller can deploy a new limit by
changing a constant in their source, with no migration step and no separate admin call.

`limit` MUST be a positive number. Zero is rejected with `400`, since warning thresholds
are computed as `used / limit`. Callers wanting to block all activity SHOULD use a limit
of `1` with every draw costing at least `1`, or stop calling the guarded operation.

A draw MAY carry an `amount` of `0`. Such an entry consumes nothing and crosses no
threshold, but its definition still reconciles (§3.1), which lets a caller create or
update a budget without spending from it.

### 3.1 Reconciliation

On every draw, the server compares the submitted definition to the stored one and
applies the following rules. Reconciliation happens **before** the draw is evaluated.

**Changing `limit`** — Takes effect immediately. **Usage MUST NOT be reset.**

Resetting usage on a limit change would make the limit trivially bypassable: any caller
(or any bug, or any attacker with the ability to send a draw) could restore full capacity
by nudging the limit. Instead, the new limit is compared against existing usage, which
means **lowering a limit below current usage is legal**. The budget is simply exhausted:
`remaining` is reported as `0`, and draws fail until the next renewal.

A limit change MUST reset the warning high-water mark to zero (§6). Thresholds are
fractions of the limit, so changing the limit changes what they mean; carrying the old
mark forward would silently suppress warnings that are legitimately breached under the new
limit. Re-firing a threshold already seen under the old limit is the acceptable cost, and
the correct direction to err — a duplicate warning is noise, a suppressed one is a budget
overrun nobody was told about.

**Changing `warnings`** — Takes effect immediately. Thresholds already crossed in the
current period do not re-fire (§6).

**Changing `renewal`** — Takes effect immediately for computing the _next_ renewal
boundary, which is recalculated from the current instant under the new rule. Usage MUST
NOT be reset. A renewal change can therefore move `renewsAt` earlier or later; it can
never refund consumed capacity.

**Unrecognized fields** — A definition containing an unrecognized field MUST be rejected
with `400`. Silently accepting a misspelled `limitt` would leave a caller believing a limit
is enforced when it is not.

### 3.2 Drift between call sites

Two call sites in the same codebase may send different definitions for the same budget
key — usually a stale copy-paste, or a rolling deploy where old and new instances
disagree.

**Last write wins.** Each draw reconciles to whatever it submitted; there is no error and
no locking. This is safe specifically _because_ usage is preserved across every
reconciliation: flapping definitions during a rolling deploy cause the limit and renewal
boundary to oscillate, but consumed capacity is never restored, so the budget cannot be
defeated by flapping.

Implementations SHOULD expose definition changes in observability output (logs, metrics,
or an audit endpoint) so unintended drift is discoverable.

---

## 4. Renewal rules

`renewal` is a tagged object. Three types are defined.

### 4.1 `never`

```json
{ "type": "never" }
```

A lifetime cap. Usage accumulates indefinitely; `renewsAt` is `null`. Useful for
per-customer allotments, trial quotas, and hard project-lifetime ceilings.

### 4.2 `interval`

```json
{ "type": "interval", "seconds": 3600, "anchor": "2026-01-01T00:00:00Z" }
```

Fixed-duration windows of exactly `seconds` length, tiled forward from `anchor`.
`seconds` MUST be a positive integer. `anchor` is OPTIONAL and defaults to the instant
the budget was first created.

Windows are **tumbling, not sliding**: at each boundary, usage resets to zero. A true
sliding window requires retaining every individual draw's timestamp and amount so
expiring draws can be subtracted one by one — unbounded storage per budget and a far
heavier implementation burden. Callers who need smoothing SHOULD compose several budgets
at different durations (e.g. a per-minute budget and a per-day budget drawn together
atomically), which approximates sliding behavior with constant storage.

Duration is expressed only in seconds, because "rolling month" is ambiguous — 28 to 31
days depending on the month, which produces silently inconsistent enforcement. Callers
wanting calendar semantics use §4.3.

### 4.3 `calendar`

```json
{
  "type": "calendar",
  "unit": "month",
  "interval": 1,
  "timezone": "America/Chicago",
  "anchor": "2026-01-15T00:00:00Z"
}
```

Boundaries aligned to civil calendar units.

- `unit` — `day`, `week`, `month`, or `year`. REQUIRED.
- `interval` — Positive integer, default `1`. `unit: "week", interval: 2` is fortnightly.
- `timezone` — IANA timezone name, default `UTC`. Determines where a "day" begins.
- `anchor` — OPTIONAL. Sets the phase: the day of month, weekday, or month of year on
  which periods begin. Defaults to the natural start of the unit (1st of the month,
  Monday, January 1st).

Timezone is a required part of this model because a "daily" budget is meaningless without
knowing whose midnight is meant.

**Month-end clamping.** When an anchor's day-of-month exceeds the length of a target
month, the boundary MUST clamp to the last day of that month. An anchor on the 31st
produces February 28 (or 29), and MUST then return to the 31st in March — the anchor is
retained, not overwritten by the clamped value. Overwriting causes anchor drift, where a
budget anchored to the 31st permanently migrates to the 28th after one February.

**Daylight saving.** Boundaries are computed in civil time in the given timezone. When a
boundary falls in a nonexistent local time (spring-forward gap), it MUST resolve to the
first valid instant after the gap. When it falls in a repeated local time
(fall-back overlap), it MUST resolve to the first occurrence.

### 4.4 Applying renewals

Renewal MUST be evaluated lazily, at the start of any request touching the budget: while
the current time is at or past `renewsAt`, advance the period and reset usage. No
background job is required, and a budget that is never touched need not be stored at all.

On renewal, usage resets to **the sum of amounts held by open reservations**, not to zero.
Reservations are not cancelled by renewal.

A hold represents capacity its holder has claimed and still intends to spend, so it
follows the caller across the boundary rather than evaporating. Zeroing usage instead
would release every outstanding hold's capacity while leaving the reservations themselves
live and committable, so the sum of committed amounts in the new period could exceed the
new period's limit — the overshoot §8 forbids.

A consequence worth noting: a reservation opened shortly before a boundary counts against
the old period at reserve time and against the new period once carried over. Long TTLs on
short periods make this routine — a 24-hour hold on a daily budget straddles a boundary
almost every time. Callers SHOULD keep TTLs short relative to the renewal period.

---

## 5. Endpoints

### 5.1 `POST /v1/charge`

Immediately and atomically consume capacity from one or more budgets.

**Request**

```json
{
  "budgets": [
    {
      "id": "r2-put-ops",
      "amount": 1,
      "definition": {
        "limit": 1000000,
        "warnings": [0.5, 0.8, 0.95],
        "renewal": { "type": "calendar", "unit": "month", "timezone": "America/Chicago" }
      }
    },
    {
      "id": "r2-storage-bytes",
      "amount": 4096,
      "definition": {
        "limit": 10000000000,
        "warnings": [0.9],
        "renewal": { "type": "calendar", "unit": "month", "timezone": "America/Chicago" }
      }
    }
  ]
}
```

`budgets` MUST contain at least one entry and at most **16**. Each entry's `id` MUST be
unique within the request; duplicate IDs MUST be rejected with `400` rather than silently
summed, since a duplicate almost always indicates a caller-side bug.

**Response `200 OK`**

```json
{
  "budgets": [
    {
      "id": "r2-put-ops",
      "requested": 1,
      "exceeded": false,
      "limit": 1000000,
      "used": 412003,
      "remaining": 587997,
      "renewsAt": "2026-09-01T05:00:00Z",
      "warningsCrossed": []
    },
    {
      "id": "r2-storage-bytes",
      "requested": 4096,
      "exceeded": false,
      "limit": 10000000000,
      "used": 9100000000,
      "remaining": 900000000,
      "renewsAt": "2026-09-01T05:00:00Z",
      "warningsCrossed": [0.9]
    }
  ]
}
```

`remaining` MUST be `max(0, limit - used)`. `renewsAt` is `null` for `never` budgets. Entries
MUST be ordered lexicographically by `id`.

**Response `402 Payment Required`** — At least one budget lacked capacity.
**Nothing was applied to any budget.**

```json
{
  "error": {
    "code": "budget_exceeded",
    "message": "1 of 2 budgets lacked capacity"
  },
  "budgets": [
    {
      "id": "r2-put-ops",
      "requested": 1,
      "exceeded": false,
      "limit": 1000000,
      "used": 412002,
      "remaining": 587998,
      "renewsAt": "2026-09-01T05:00:00Z",
      "warningsCrossed": []
    },
    {
      "id": "r2-storage-bytes",
      "requested": 4096,
      "exceeded": true,
      "limit": 10000000000,
      "used": 9999999000,
      "remaining": 1000,
      "renewsAt": "2026-09-01T05:00:00Z",
      "warningsCrossed": []
    }
  ]
}
```

#### The response covers the whole group

The `budgets` array MUST list **every budget in the group**, not only the ones the request
named. Budgets the request never drew from carry `requested: 0`, `exceeded: false`, and an
empty `warningsCrossed`.

The server holds the entire group in one transactional unit already (§8.1), so reporting all
of it costs nothing and means every response is a complete, consistent picture of the
atomicity domain at one instant. A caller never has to follow a draw with a read to find out
where the rest of its budgets stand.

Because the array describes the group rather than the request, it is ordered by the group's
own key: entries MUST appear in lexicographic `id` order, drawn and undrawn alike. Every
response in this protocol therefore carries the same entries in the same order, whatever the
endpoint and whatever the status, and two reads with no draw between them are byte-identical.

A caller locates its own entries by `id`, or by filtering on `requested > 0` for the ones
this request drew from. It identifies what blocked by filtering on `exceeded`; the array
MUST have **the same shape and the same ordering on `402` as on `200`**. Client code
therefore reads `budgets` identically regardless of status and branches only on the status
code itself, and a caller diagnosing a blocked multi-budget draw can see how close the
_other_ budgets were, not merely which one hit its wall.

The `message` on a `402` counts only the budgets the request named — a draw against 1 budget
inside a group of 5 reports `1 of 1`, never `1 of 5`. Budgets the request never touched did
not participate in the failure and MUST NOT inflate the denominator.

`exceeded` MUST be `true` for **every** budget that lacked capacity, not merely the first
one encountered. Reporting one failure at a time forces a retry loop that rediscovers the
same wall repeatedly.

Because nothing was applied, `used` and `remaining` on a `402` MUST reflect state
_without_ the requested draw, and `warningsCrossed` MUST be empty for every entry — no
threshold can have been crossed by a draw that never happened.

A `retry-after` header MUST accompany this response, set to the number of seconds until
the earliest `renewsAt` among the budgets with `exceeded: true`. It MUST be omitted when
every such budget is `never`, since no amount of waiting will help.

### 5.2 `POST /v1/reserve`

Hold capacity for an operation whose exact cost is not yet known.

Request body is identical to `/v1/charge`. The `hh-ttl-seconds` header sets the hold
duration. If absent, the implementation's default applies. Implementations MUST document
their default, SHOULD default to 300 seconds, and MUST support values up to at least 86400.

**Response `200 OK`**

```json
{
  "reservationId": "rsv_01J9X2K4M5N6P7Q8R9S0T1U2V3",
  "expiresAt": "2026-08-15T14:32:05Z",
  "budgets": [/* same shape as charge */]
}
```

Held amounts count toward `used` immediately. Failure semantics are identical to
`/v1/charge`.

An expired reservation MUST automatically return its held capacity. Implementations MAY
do this lazily — on next access to the budget — rather than with a timer.

### 5.3 `POST /v1/commit`

Finalize a reservation, optionally correcting the amounts. The reservation is identified
by the REQUIRED `hh-reservation-id` header.

**Request**

```json
{
  "budgets": [{ "id": "r2-storage-bytes", "amount": 3812 }]
}
```

The body is OPTIONAL. Any budget from the original reservation **not** listed here commits
at its originally reserved amount. Omission means "the estimate was right," which is the
common case; it never means "release this one."

The body MUST NOT introduce a budget ID absent from the original reservation — that would
be a draw with no capacity check behind it, so it MUST be rejected with `400`.

Per budget, comparing the committed amount to the reserved amount:

- **Lower** — The difference is returned to the budget.
- **Equal** — The hold converts to a spend.
- **Higher** — The difference is evaluated as a fresh draw and MAY fail.

If any increase lacks capacity, the entire commit MUST fail with `402` and the
reservation MUST remain open and unchanged, so the caller can retry with a lower amount or
release it. Implementations MUST NOT partially apply a commit.

**Response `200 OK`** — Same body shape as `/v1/charge`, reporting post-commit state.
`requested` is the **committed** amount for each budget — the corrected amount where one was
submitted, the originally reserved amount otherwise. `warningsCrossed` is computed normally
(§6), since a commit is a successful draw.

**Response `404 Not Found`** — Unknown or expired reservation. An expired reservation is
`404`, not `410`: its capacity has already been returned, and the caller's correct
response is to treat the operation as unbudgeted and start over.

**Response `409 Conflict`** — The reservation was already **released**. Committing a
released reservation is a caller-side logic error.

**Idempotency.** Committing an already-committed reservation MUST return `200` with the
original commit's result, ignoring any newly submitted amounts. The reservation ID is
itself sufficient for deduplication, so `idempotency-key` is not required here — a
network-level retry of a commit naturally converges.

### 5.4 `POST /v1/release`

Return a reservation's held capacity without spending it. The reservation is identified by
the REQUIRED `hh-reservation-id` header.

No request body. Responses mirror `commit`: `200` with the post-release budget state;
`404` for unknown or expired; `409` if already **committed**. Releasing an
already-released reservation MUST return `200`, for the same idempotency reason as above.

Nothing is drawn by a release, so `requested` MUST be `0` and `warningsCrossed` MUST be empty
for every budget. Combined with the whole-group rule of §5.1, every entry in a release
response is therefore uniformly zero-outcome: the body reports the group's post-release state
and does not itself identify which budgets the reservation held. A caller needing that has the
reserve response, which named them.

### 5.5 `GET /v1/budget`

Read current state without drawing. Returns **every budget in the group**, so a caller
learns the whole state of an atomicity domain in one request. Honors `hh-tenant`.

There is no per-budget read and no `hh-budget-id` header. A group is already the unit a
request addresses and the unit an implementation stores together (§8.1), so returning one
budget at a time would make reading a group an N-request operation to recover state the
server holds in one place. Callers wanting a single budget filter the array client-side;
callers wanting the group, which is the common case, pay for one round trip.

**Response `200 OK`** — A `budgets` array holding one entry per budget in the group, in the
same shape as a `/v1/charge` entry, with `requested`, `exceeded`, and `warningsCrossed`
omitted. Entries MUST be ordered lexicographically by `id`, so the response is stable across
calls and between implementations. The array wrapper matches every other response in this
protocol, so a single decoder handles them all.

```json
{
  "budgets": [
    {
      "id": "r2-put-ops",
      "limit": 1000000,
      "used": 412003,
      "remaining": 587997,
      "renewsAt": "2026-09-01T05:00:00Z"
    },
    {
      "id": "r2-storage-bytes",
      "limit": 10000000000,
      "used": 9100000000,
      "remaining": 900000000,
      "renewsAt": "2026-09-01T05:00:00Z"
    }
  ]
}
```

The read MUST be atomic with respect to draws: every entry MUST reflect the same instant, so
a group read concurrent with a multi-budget draw MUST NOT show that draw applied to some of
its budgets and not others. This falls out of §8.1's one-unit-per-group mapping and is the
other reason to read a group as a whole. Reading budgets one at a time cannot offer it, since
a draw may land between two of the calls.

**Response `200 OK` with an empty array** — No budget in this `(scope, tenant, group)` has
been drawn against yet. This is not an error: budgets are created lazily on first draw, so an
empty group is simply one nothing has been spent from. There is no `404` on this endpoint.

---

## 6. Warnings

`warnings` is an array of at most **32** fractions where `0 < w < 1`. Values MUST be
strictly between zero and one; `1.0` is not a warning threshold, it is the limit itself,
and accepting it would produce a "warning" indistinguishable from exhaustion.

A budget MUST track a **high-water mark**: the greatest usage fraction observed in the
current period. On a successful draw or commit, the server computes the new fraction
`used / limit` and returns every threshold that is greater than the previous high-water
mark and less than or equal to the new fraction, in ascending order, as
`warningsCrossed`. It then advances the high-water mark.

The high-water mark MUST NOT decrease when capacity is returned by a release or a
downward commit. Without this, usage hovering around a threshold would re-fire it
repeatedly — the classic alert-flapping failure, and the fastest way to get an
integration's notifications muted.

A single draw MAY cross several thresholds at once (a large charge jumping from 40% to
90% crosses both `0.5` and `0.8`); all crossed thresholds MUST be reported.

The high-water mark resets to zero in exactly two cases: on renewal (§4.4), and on a
change to `limit` (§3.1). It resets in no other case. In particular, a change to the
`warnings` array alone MUST NOT reset it, since the thresholds still mean the same thing
relative to the same limit.

`warningsCrossed` MUST be present on every successful response, empty when nothing was
crossed. Delivery of warnings to external systems (webhooks, email, paging) is out of
scope for this protocol.

---

## 7. Idempotency

`idempotency-key` is REQUIRED on `/v1/charge` and `/v1/reserve`. Both consume capacity,
and a caller retrying after a lost response cannot otherwise know whether the original
request applied.

The deduplication identity is `(scope, tenant, group, endpoint, idempotency-key)`.

Group is included because a draw is confined to one group, so its idempotency record lives
naturally alongside the budgets it touched. The same key used under two different groups
refers to two unrelated operations and MUST NOT collide.

- **Replay of a completed request** — Return the original response, status code and body
  identical, without re-applying anything.
- **Same key, different request** — Reject with `409 Conflict` and code
  `idempotency_conflict`. Serving the original response for a materially different
  request would silently drop a real charge.
- **Concurrent replay** — If a request with the same key is still in flight,
  implementations SHOULD respond `409` with code `idempotency_in_progress`.

A replay reproduces an earlier response rather than producing a new one. The whole-group rule
of §5.1 constrains a response at the instant it is first produced, so a replayed `budgets`
array describes the group as it stood then — including which budgets existed — even if the
group has since gained budgets or drawn further. Re-rendering it against current state would
mix two instants in one body: the caller's `warningsCrossed` from the original draw sitting
beside `used` values its draw did not produce. The frozen body answers "what did my operation
do", which is the only question a replay is asked; a caller wanting the group as it stands now
has `GET /v1/budget`.

The same applies to a repeat `/v1/commit` or `/v1/release` on a settled reservation (§5.3,
§5.4), which replays the body stored when the reservation settled.

### 7.1 What counts as a different request

The comparison MUST consider **only the set of budget IDs and their amounts**. The
`definition` object MUST be excluded from it.

Definitions travel inline with every draw (§3), so a caller who deploys a limit change
while an operation is in flight would otherwise see the retry of that operation rejected
as an idempotency conflict — the request body changed, though the operation did not.
The caller is then stuck: it cannot retry safely and cannot determine whether the original
applied, which is precisely the situation idempotency exists to prevent. Definition drift
is already handled by last-write-wins reconciliation (§3.2) and needs no protection here.

### 7.2 Failed draws are not recorded

A draw that fails with `402` MUST NOT create an idempotency record. Nothing was applied,
so there is no outcome to deduplicate, and a subsequent request carrying the same key MUST
be evaluated fresh.

Caching a `402` would make it outlive the condition that caused it. Records persist for at
least 24 hours while a daily budget renews inside that window, so a caller retrying after
renewal — with capacity now genuinely available — would be served a stale denial for the
rest of the day.

Implementations MUST retain idempotency records for at least 24 hours and MUST document
their retention window. Records MAY be discarded afterward; a replay past the window is
treated as a new request.

Callers MUST generate the key once per logical operation and reuse it across retries.
Generating a fresh key per attempt defeats the mechanism entirely.

---

## 8. Atomicity

**This section is normative and non-negotiable. An implementation that violates it does
not conform, regardless of what else it gets right.**

1. **All-or-nothing across budgets.** A draw referencing several budgets MUST apply to all
   of them or to none. If any lacks capacity, no budget's usage may change. Partial
   application is the failure mode that makes the entire protocol untrustworthy: a caller
   told "denied" while capacity was silently consumed cannot reason about its own spend.

   Every draw is confined to a single group (§1.2), so this requirement is always
   satisfiable within one atomicity domain. No conforming request requires a distributed
   transaction.

2. **Atomic check-and-decrement.** The capacity check and the usage update MUST be a
   single atomic operation per budget. Read-then-write without isolation permits two
   concurrent draws to both observe sufficient capacity and both proceed, overshooting the
   limit — which is precisely the outcome this protocol exists to prevent.

3. **Consistent lock ordering.** Implementations acquiring per-budget locks MUST order
   acquisition deterministically (lexicographic by budget key is sufficient). Without
   this, two multi-budget draws touching the same budgets in opposite orders can deadlock.

4. **Overshoot is never acceptable.** Under no concurrency, failure, or retry pattern may
   committed usage exceed the limit, except as a direct consequence of an operator
   lowering the limit below existing usage (§3.1).

Implementations SHOULD be verified with a conformance test that issues many concurrent
draws against a single budget and asserts total committed usage never exceeds the limit.
This is the defect most likely to survive casual testing, because it appears only under
real concurrency.

### 8.1 Implementation note (non-normative)

Map each `(scope, tenant, group)` triple onto one transactional unit — one row group, one
actor, one document, one object — and requirements 1 through 3 come for free. A draw
touches exactly one unit, the storage engine's own transaction supplies atomicity, and
serialized execution within the unit removes any lock-ordering concern.

The residual design question is granularity, and callers control it through `hh-group`:

- **Coarse.** Few groups, each covering many budgets. Anything can be drawn with
  anything within a group, at the cost of serializing all of that group's draws
  through one unit.
- **Fine.** One group per subsystem, holding only budgets genuinely drawn together.
  Groups then proceed fully in parallel.

Since groups are mandatory and part of budget identity, this choice is made once, at
the point a budget is first drawn, and is not cheaply revisited (§1.2).

Implementations SHOULD NOT attempt distributed transactions across groups. Nothing in the
protocol requires one.

---

## 9. Extension points

This protocol deliberately omits several concerns so implementations can layer them
without diverging from the wire format.

**Authentication.** The _scheme_ is implementation-defined; the _placement_ is not.

A conforming server MAY require API keys, OAuth, mTLS, a signed header, or nothing at all.
This document does not say how a credential is minted, what it looks like, how long it
lives, or how it is verified. It fixes only where one travels, because a client that cannot
predict that cannot be written once and pointed at an arbitrary implementation.

1. **One header.** A server requiring credentials MUST accept them in the standard
   `authorization` request header, and MUST NOT require them anywhere else: not in another
   header, not in the query string, not in the request body. The header's value is opaque to
   this protocol; servers SHOULD use the `Bearer <token>` form of RFC 6750 so that the
   commonest client configuration works with no per-server adaptation.

   A server MAY _additionally_ accept a credential elsewhere (mTLS at the transport layer, a
   vendor header) as long as `authorization` alone is always sufficient.

2. **Always sendable.** A caller MAY send `authorization` on every request to every endpoint,
   and a client SHOULD do so whenever it has been given a credential. A server that does not
   authenticate, or that resolves this particular request's scope some other way, MUST ignore
   an `authorization` header it has no use for. It MUST NOT reject the request as malformed,
   and MUST NOT vary its behavior based on the header's presence or content.

   This is the rule that makes one client work everywhere. Without it, a client holding a
   credential would have to know in advance whether a given deployment wants it, and pointing
   that client at an unauthenticated self-hosted server would fail on a header the server
   simply had no opinion about.

3. **Scope comes from the credential, never from the caller.** Every request MUST resolve to
   exactly one **scope** (§1), and the resolution MUST be the server's alone. This protocol
   defines no header, field, or path segment by which a caller names its own scope, and an
   implementation MUST NOT define one: a scope a caller can ask for is a scope a caller can
   ask for someone else's. Callers subdivide with `hh-tenant` (§1), which lives _inside_ the
   scope the credential resolved to and therefore grants nothing.

4. **Rejection is uniform.** A server MUST respond `401` with code `unauthenticated` when
   credentials are absent or invalid, and `403` with code `forbidden` when valid credentials
   lack access to what was requested. Both carry the standard error body of §10. A `401`
   SHOULD carry a `www-authenticate` header naming the scheme the server wants.

5. **Rejection happens first, and changes nothing.** Authentication MUST be resolved before
   the request is otherwise validated or applied. A request that fails it MUST receive `401`
   or `403` even if it is also malformed. Reporting `400` on an unauthenticated request leaks
   whether a body was well-formed to a caller with no standing to know. Such a request
   MUST NOT draw, MUST NOT settle a reservation, and MUST NOT create or consume an
   idempotency record (§7): the same key remains available to a later, authenticated retry.

**Multi-key and rotation.** An implementation MAY map several credentials to one scope, and
a caller MAY change the credential it sends between requests without any effect on budget
state. Scope is what identifies a budget (§1); the credential merely proves entitlement to
it. Two keys resolving to one scope therefore address the same budgets and share
idempotency records, which is what makes key rotation a non-event.

**Notifications.** Webhooks, email, and paging on `warningsCrossed` or `402` are out of
scope.

**Analytics and audit.** Out of scope.

**Endpoints, headers, and error codes beyond this document.** An implementation MAY define
its own, and chooses their names. Nothing here reserves a namespace for them: the endpoints
this document defines are a closed set of static paths (§2), so a name it does not define
cannot collide with a future one by accident.

---

## 10. Error format

Every non-2xx response MUST carry this body:

```json
{
  "error": {
    "code": "budget_exceeded",
    "message": "Human-readable description."
  }
}
```

`code` is a stable machine-readable string; `message` is for humans and MUST NOT be
parsed.

On `402`, and only on `402`, a top-level `budgets` array accompanies `error`, in the shape
defined in §5.1. It is a sibling of `error`, not nested inside it, so that the decoder
reading `budgets` on a `200` reads the identical field on a `402`.

| Status | Code                      | Meaning                                                                                                                                                                                                        |
| ------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid_request`         | Malformed body, missing field, unknown definition field, negative amount, zero or negative limit, duplicate budget ID, more than 16 budgets, missing `hh-group`, identifier failing the charset rules of §1.1. |
| 401    | `unauthenticated`         | Missing or invalid credentials (§9). Takes precedence over `400`.                                                                                                                                              |
| 403    | `forbidden`               | Valid credentials, insufficient access (§9). Takes precedence over `400`.                                                                                                                                      |
| 404    | `reservation_not_found`   | Unknown or expired reservation.                                                                                                                                                                                |
| 402    | `budget_exceeded`         | Insufficient capacity. Accompanied by a top-level `budgets` array.                                                                                                                                             |
| 409    | `idempotency_conflict`    | Key reused with a different body.                                                                                                                                                                              |
| 409    | `idempotency_in_progress` | Identical key currently in flight.                                                                                                                                                                             |
| 409    | `reservation_settled`     | Reservation already in the opposing terminal state.                                                                                                                                                            |
| 409    | `budget_group_conflict`   | OPTIONAL. Budget ID drawn under a group other than the one it was created in.                                                                                                                                  |
| 500    | `internal_error`          | Unexpected server failure.                                                                                                                                                                                     |
