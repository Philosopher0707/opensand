# Wilson boundary numbers in a design doc must be checked against the formula before tests pin them

- **Trap:** The Phase 7 design (docs/design/phase7-mesh-tournament.md) pinned the
  routing boundary as "one `check_failed` after 9/10 gives a Wilson lower bound of
  about 0.47". Implementing S1 against the standard Wilson formula (z = 1.96) gave
  9/11 → 0.523 — the start would NOT move — while 9/12 → 0.468 does. The doc's own
  other pinned numbers (9/20 → 0.26, 20/28 → 0.53) matched the standard formula, so
  the boundary number, not the formula, was the slip.
- **Root Cause:** The design's worked example was computed by hand (or from memory)
  and never recomputed from the formula the same document specifies; an off-by-one
  failure in the sample count survived review.
- **Rule:** When a design pins a numeric boundary for a test, recompute every pinned
  number from the code's actual formula (one script run) before writing the test; if
  a pinned number disagrees with the formula the formula wins and the doc gets
  corrected in the same PR.
