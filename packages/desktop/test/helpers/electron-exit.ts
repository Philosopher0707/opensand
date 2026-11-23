import type { ChildProcess } from "node:child_process";

/**
 * Resolve when an Electron child has actually exited, not when its stdio pipes reach EOF.
 * Electron leaves helper processes that can keep those pipes open after the main process is
 * gone, so `close` may never fire and the test hangs until the runner's ceiling kills it.
 * A short grace lets buffered stdout (the __RESULT__ line) arrive before we release the pipes.
 */
export function whenElectronExited(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    let code: number | null = null;
    let exited = false;
    let settled = false;
    const finish = () => {
      if (settled || !exited) return;
      settled = true;
      resolve(code ?? 0);
    };
    child.once("exit", (c) => {
      exited = true;
      code = c;
      const release = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }, 500);
      release.unref();
    });
    child.once("close", (c) => {
      exited = true;
      code = c;
      finish();
    });
  });
}
