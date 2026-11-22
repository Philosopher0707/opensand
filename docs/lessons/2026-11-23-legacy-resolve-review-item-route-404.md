# Team review resolution route is POST /api/team-review/resolve, not /api/team-review/:id/resolve

- **Trap:** Legacy `renderer/app.js` `resolveReviewItem` posted to `/api/team-review/${itemId}/resolve`, which returned HTTP 404 because `desktop-server.ts` only registers `POST /api/team-review/resolve` with `{itemId, decision}` in the JSON body. In the legacy UI, approving or rejecting proposals in the review queue silently failed.
- **Root Cause:** The legacy client assumed a parameterized URL path instead of matching the route registered in `desktop-server.ts`. Because the call was not exercised against a real server handler in legacy unit tests, the defect remained undetected until the Preact rewrite.
- **Rule:** Always verify client HTTP paths and payloads against the actual route registrations in `desktop-server.ts`. Protect client modules with `shell-route-contract.test.ts` to statically reject unregistered paths, and write unit tests that execute against the real route handler.
