# A real-window size loop must reset every panel after Stop

- **Trap:** The OCR real-window test passed its 960×740 checks but failed at 1920×1080 with `panel starts idle: 'done' !== 'idle'`, even though each size had clicked Dismiss once.
- **Root Cause:** The second scan in each size ended with Stop, which leaves the panel in `done` with "Stopped."; Dismiss had been clicked before that second scan, so the next size inherited a finished panel. The idle-height CSS made the leak invisible in the screenshot.
- **Rule:** At the end of every real-window phase, including after a cancel/Stop path, dismiss the panel and wait for `data-status="idle"` before moving to the next window size. Assert the idle precondition at the start of each size.
