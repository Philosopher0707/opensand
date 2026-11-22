# Real-window persona deletion races bridge handler over in-memory mocks

**Trap:** In Electron real-window tests, deleting an agent persona through the UI appears to succeed via the native bridge (`opensand:deleteAgent`), but subsequent UI reload continues to render the deleted persona because in-memory test mocks (`__testBots` or HTTP route mocks) were bypassed by the bridge and remained populated.

**Root Cause:** The `BotsData` client layer prioritizes bridge methods (`b?.deleteAgent`) before falling back to HTTP routes (`DELETE /api/agents/:id`). In tests using in-memory mock stores (`window.__testBots`), calling the IPC bridge does not prune the test array. When the component calls `reload()`, `getAgents()` reads `window.__testBots` directly, observing the old unpruned state and failing post-deletion length assertions.

**Rule:** Data adapter methods that support test mock arrays (`__testBots`, `__testAgents`) must prune those mock arrays directly on deletion before or alongside forwarding to the bridge. Test runners that stub route handlers should explicitly unbind conflicting bridge methods (`delete window.opensand.deleteAgent`) so mocked HTTP endpoints own the full lifecycle.
