// Child process for standing-grants-race.test.ts. Not a *.test.js file, so the runner never executes it directly.
//   revoke <baseDir> <grantId>        revoke the grant, print "revoked epoch=E"
//   hold   <baseDir> <ms>             hold grants.lock for <ms>, print "locked" once held
import { GrantsStore } from "@opensand/shared";

const [mode, baseDir, arg] = process.argv.slice(2);
const store = new GrantsStore({ baseDir, updatedBy: "test:worker" });

if (mode === "revoke") {
  const res = await store.revokeGrant(arg);
  console.log(`revoked epoch=${res.epoch}`);
} else if (mode === "hold") {
  await store.underLock(async () => {
    console.log("locked");
    await new Promise((r) => setTimeout(r, Number(arg)));
  });
  console.log("released");
}
