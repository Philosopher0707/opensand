# Prose policy rules (design, not built)

Status: designed 2026-11-12, not implemented. It gets built when a user asks to write permission
rules in words. Until then the regex/prefix rules in `policy-engine.ts` are the only rules.

## Problem

Grok Bot 1.0.1 accepts `allow_instructions` / `block_instructions` in plain language ("never push
to main", "running the test suite is fine"). OpenSand rules are structured `PolicyRule` objects
(`packages/local-exec-daemon/src/policy-engine.ts:12-27`), which are precise but awkward to write.

## Decision

**Compile prose into ordinary `PolicyRule`s once, when the rule is written. Never ask a model at
tool-call time.**

Why: enforcement stays deterministic, auditable and offline; a tool call never waits on a model; a
prompt-injected tool output cannot argue its way past a rule, because no model is in the path when
the rule is checked.

Rejected: classifying each tool call against the prose at run time. It is slow, costs a call per
tool use, gives different answers for the same call, and puts a model the attacker can talk to
inside the security boundary.

## Shape

```ts
interface PolicyRule {
  // ...existing fields...
  source?: {
    kind: "prose";
    text: string;          // what the user wrote
    textSha256: string;    // recompile when it changes
    compiledAt: number;
    compiler: string;      // model id that proposed the conditions
  };
}
```

## Flow

1. The user writes a sentence in Settings → Permissions, under Allow or Block.
2. The compiler (one model call, strict JSON schema whose fields are `PolicyRule.conditions`)
   proposes `tools`, `commandsRegex`, `pathsPrefix`, `pathsRegex`, `initiators`.
3. **Dry run:** the proposal is evaluated against the last 200 policy audit entries
   (`getAuditLog`). The user sees "would have allowed 14 calls, would have blocked 2" with examples.
4. The rule is saved with `enabled: false`. Only the user's explicit "Turn on" enables it. A
   routine, a subagent or a model cannot enable it.
5. If the compiler cannot produce conditions, the sentence is kept as an unenforced note and the UI
   says so. Nothing is ever enforced from a guess.

## Asymmetry rules (allow is dangerous, block is not)

- Block prose may compile to `DENY` or `REQUIRE_APPROVAL`.
- Allow prose compiles only to `ALLOW`, and only when it names at least one tool and, for
  `exec_command`, an anchored `commandsRegex` (`^...`). It is refused if it contains an unanchored
  `.*`, shell chaining (`;`, `&&`, `|`, `` ` ``, `$(`), or a tool wildcard.
- A compiled `ALLOW` rule is refused if it matches any sample from the built-in deny set
  (`/etc/`, `.ssh`, `.env`, `rm -rf`...). `DENY` is already evaluated first (`policy-engine.ts:130`),
  so this check stops the user from being told they are allowed something that is still blocked.

## Tests owed when built

- Golden fixtures: prose → conditions, with the compiler stubbed (no live model in CI).
- A property test: no accepted `ALLOW` rule matches any built-in deny sample.
- The enable path: a prose rule stays disabled until the user's action, not the compiler's output.
- Mutation probe: remove the anchoring check, and a fixture must fail.

Effort: one PR, medium (compiler + schema + dry-run view + tests). No change to `evaluate()`.
