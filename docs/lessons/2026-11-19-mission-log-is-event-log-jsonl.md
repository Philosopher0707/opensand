# The mission log is event-log.jsonl, not log.jsonl — hand-built log paths silently fork the records

- **Trap:** Phase 7 S4 built the mission log path as
  `<stateDir>/missions/<id>/log.jsonl` and appended `mesh.tournament.started`,
  `model.call` and `mesh.attempt.result` through an `EventLogWriter` — while
  the tests read `log.jsonl` too. The tournament ran green but the log held
  only the `mesh.decision` (the one record written through a path that
  happened to be right); every other record was missing.
- **Root Cause:** `resolveEventLogPath` names the per-mission log
  `event-log.jsonl`; `log.jsonl` is a different, plain (non-chained) file that
  S2's attempt lifecycle uses by default. An `EventLogWriter` constructed with
  a directory writes `<dir>/event-log.jsonl` no matter what the caller
  believed the mission log is called.
- **Rule:** Never construct a log path by hand or by name. Derive it from
  `logDirFor(stateDir, scope, id)` + `resolveEventLogPath`, or take the path
  from `writer.path` after constructing the writer, and read through
  `EventLogReader(writer.path)`. If two record families must not share a
  chained log, give the plain one an explicit name (S4 uses
  `attempts-log.jsonl`) and say so in the writer's doc comment.
