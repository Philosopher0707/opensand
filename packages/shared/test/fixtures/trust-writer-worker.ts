// Forked by folder-trust-store.test.ts: lowers one folder to untrusted and adds one grant, then exits.
import { FolderTrustStore } from "../../src/folder-trust-store.js";

const [baseDir, folder, index] = process.argv.slice(2);
const store = new FolderTrustStore({ baseDir, updatedBy: `worker:${index}` });
await Promise.all([
  store.setLevel(folder, "untrusted"),
  store.grants.addGrant({ id: `worker-${index}`, tool: "exec_command", scope: `cmd${index} *`, lifetime: "always" }),
]);
