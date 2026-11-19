# Option overrides merged with explicit undefined clobber the defaults

- **Trap:** Phase 7 S4 built limits as
  `resolveTournamentLimits({ ...options.limits, attempts: options.attempts ?? options.limits?.attempts })`.
  With no `attempts` given, the spread carried `attempts: undefined`, which
  overwrote the default of 3 — tournaments ran zero attempts and three tests
  failed at once with unrelated-looking symptoms (missing records, null
  winner, empty request log).
- **Root Cause:** Object spread applies explicit `undefined` values as
  assignments; only absent keys fall back to the default. A `??` on the right
  side cannot save the default when the left side produces `undefined` that
  then still lands in the object.
- **Rule:** When merging optional overrides onto defaults, filter undefined
  first (`for (const [k, v] of Object.entries(raw)) if (v !== undefined) …`)
  or never build the object with keys that can be undefined. When several
  tests fail together after one refactor, check a shared default-merging
  helper before reading each test in turn.
