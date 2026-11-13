// Forked by grants-store.test.ts: adds one distinct grant and exits.
import { GrantsStore } from "../../src/grants-store.js";

const [baseDir, index] = process.argv.slice(2);
const store = new GrantsStore({ baseDir, updatedBy: `worker:${index}` });
await store.addGrant({ id: `worker-${index}`, tool: "exec_command", scope: `cmd${index} *`, lifetime: "always" });
