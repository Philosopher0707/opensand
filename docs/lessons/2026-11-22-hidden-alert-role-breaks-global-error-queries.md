# A hidden role="alert" still matches global error selectors

**Trap:** Adding `<div id="authErrorMsg" role="alert" style="display:none">` to the shell made an unrelated real-window test fail: it asserted no `[role=alert]` element on a healthy mission view and found the hidden auth error container.

**Root Cause:** `querySelector('[role=alert]')` matches hidden elements by attribute; visibility is irrelevant to the selector.

**Rule:** Put an alert role on an error container only while it actually holds an error (`role={error ? "alert" : undefined}`); keep it out of the DOM's accessible-error set when empty, which also avoids stealing screen-reader focus from real errors.
