# The fake DOM in the Inbox tests supports only simple selectors and no stopPropagation

- **Trap:** The new decision-button tests found no buttons, because the scoped selector `.inbox-decision-row button` is a descendant selector, and the fake `querySelectorAll` only matches one simple selector. A later handler call to `e.stopPropagation()` would also throw in the fake.
- **Root Cause:** `test/inbox-component.test.ts` hand-rolls a minimal DOM. It does not bubble events and has no `stopPropagation`.
- **Rule:** In that fake, query a container first with a single class, then look for `button` inside it (`container.querySelector(".inbox-decision-row")!.querySelectorAll("button")`). The fake's `dispatchEvent` gives every event a no-op `stopPropagation`. Do not add descendant selectors to the fake; scope the query instead.
