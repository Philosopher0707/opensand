# The judge's tie band fires without a reviewer — separate the costs or expect fallback-deterministic

- **Trap:** The Phase 7 S5 e2e scripted two passing attempts with near-identical
  usage, then asserted the receipt says `Judge: deterministic … No tie-break.`
  The receipt actually said the reviewer output was invalid and the judge fell
  back to deterministic.
- **Root Cause:** The §5.3 band is diff-based AND cost-based (within 10% + 20
  lines / 10% of cost), and `judgeAttempts` reaches Stage 2 whenever the band
  holds more than one attempt — even with no `review` function, which records
  `fallback-deterministic`. Two same-priced passers are always in the band.
- **Rule:** In any scripted tournament where the receipt must show a plain
  deterministic decision, give the tied passers usage far enough apart that the
  cost band (10%) cannot include the second — or script a reviewer and assert
  `tieBreak: "reviewer"` instead.
