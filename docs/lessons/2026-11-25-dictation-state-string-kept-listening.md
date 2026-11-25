# A truthy state string kept Dictate stuck in "Listening" (2026-11-25)

**Trap:** The real-window test stopped dictation, the fake recognition received `stop()`, but the button still read "Listening..."; its `aria-pressed` showed `"idle"`. The stop path looked correct and the model unit tests passed.

**Root Cause:** The model emits `DictationState = "idle" | "listening"`, while the view holds a Preact boolean `listening`. Passing `onState` straight into `setListening` stored the non-empty string `"idle"`, which is truthy, so `listening ? "listening" : "idle"` kept rendering the listening label. Unit tests asserted the model's state array, not the view's boolean interpretation.

**Rule:** Map enum states to booleans at the view boundary (`onState: (state) => setListening(state === "listening")`) and add a real-window assertion on the rendered button state after every terminal path. A string state is not a boolean state, even when it says "idle".
