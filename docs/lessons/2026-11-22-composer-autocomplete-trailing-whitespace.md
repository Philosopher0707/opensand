# Autocomplete trigger substitution and trailing whitespace normalization

- **Trap:** Autocompleting slash commands or mentions in the composer input when text already contains a trailing space after the query (e.g. `Hello /doc more text`) caused doubled whitespace (`Hello /doctor  more text`) and an off-by-one caret positioning error.
- **Root Cause:** Naive concatenation of the inserted suggestion with a trailing space (`${before}${itemTitle} ${after}`) without inspecting whether `after` already began with a whitespace character.
- **Rule:** Trigger autocomplete replacement helpers must inspect `after` and trim one leading whitespace character when inserting a space-delimited command, ensuring consistent whitespace and caret placement across both end-of-string and mid-sentence autocompletions.
