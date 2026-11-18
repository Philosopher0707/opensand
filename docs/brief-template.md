# Bot brief template

Every bot brief must name these four sections before work starts. `scripts/lint-brief.sh`
checks their presence; `scripts/verify.sh` checks this template on every build.

Goal: the outcome this job must reach, in one sentence.

Done when: the observable finish line — merged PR, green CI, passing selftests, updated map.

Scope: directories and files the bot may touch, and the ones it must not touch.

Report back with: PR number, merge commit, selftest output, and anything left unverified.

Steps: ordered actions the bot should follow (optional, but useful for multi-step jobs).
