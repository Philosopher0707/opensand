// Forked by grants-store.test.ts: revokes one grant (takes grants.lock) and exits.
import { GrantsStore } from "../../src/grants-store.js";

const [baseDir, grantId, doneFile] = process.argv.slice(2);
const store = new GrantsStore({ baseDir, updatedBy: "worker:revoke" });
const res = await store.revokeGrant(grantId);
await import("node:fs").then((fs) => fs.writeFileSync(doneFile, JSON.stringify(res)));
