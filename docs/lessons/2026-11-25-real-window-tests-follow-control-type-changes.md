# Real-window tests must follow a control when an input becomes a dropdown

- **Trap:** macOS CI failed in the welcome real-window test after the Settings model field became a `<select>`; the test still assigned it through `HTMLInputElement.prototype`.
- **Root Cause:** The renderer change was correct, but the real-window helper encoded the old control type and threw before the settings flow could finish.
- **Rule:** When a settings control changes element type, update its real-window setter and assertions in the same change; use the select setter for model dropdowns and keep input setters only for text/password fields.
