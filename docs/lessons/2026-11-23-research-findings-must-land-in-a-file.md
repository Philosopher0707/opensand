# Research findings kept only in chat were interleaved and truncated when the job stopped

**Trap:** A benchmark research job gathered evidence from six apps in parallel subagents. Its tables existed only in chat messages; when the job stopped, the messages were cut at 8,000 characters and the parallel outputs for two apps were interleaved into garbled rows. The retry had to rebuild the tables from session notes and re-fetch the affected pages instead of continuing the draft.

**Root Cause:** Chat output is not a durable draft. Session-history reads truncate long messages, and concurrent subagent results can arrive concatenated, so a table that exists only in a message can lose row boundaries and source attribution. Nothing had been written to the worktree file before the stop.

**Rule:** For any multi-source research task, write each app's/source's verified rows into the target document in the worktree as soon as they are gathered, with the source link and Observed/Inferred marker on the row. Treat chat as a progress log, not the artifact. Before drafting, re-check every URL and re-fetch any row whose attribution looks mixed; a 200 status proves the link resolves, not that a quoted string came from that page.
