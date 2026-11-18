# A real-window run that ends in an error still passes "finished"

- **Trap:** At both sizes the quick capture ends in `error` (`model 'llama3.1' not found` from the local Ollama endpoint). The window test accepts `done` or `error` as finished, so the run passes without proving an answer.
- **Root Cause:** The hermetic test home has no configured model, and the Ollama endpoint responds 404. The test was written to prove the panel resolves and stays inside the window, not that the model answers.
- **Rule:** A window test states which terminal state it accepts and prints the final label in its output. A capture screenshot of an answer needs a configured model in the test home. Until then, report the error state as what was shown, not as an answer.
