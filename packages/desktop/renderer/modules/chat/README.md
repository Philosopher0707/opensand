# Renderer modules (Phase 2 seeding)

These are the canonical copies extracted from `app.js` (4,700+ lines).
They are seeded now; the switch-over to `import` happens in a follow-up
commit so each move is small and reviewable.

- `markdown.js` — XSS-hardened renderer (escape-first, link allowlist)
- `approval-queue.js` — inline approval card queue (one card per approval)

To wire one in: change `app.js` to import from `./modules/chat/<name>.js`
and add per-module tests.
