# Vendored plain .mjs assets in compiled packages and CommonJS test fakes

**Trap:** Vendoring plain JavaScript or shell assets (`agent_wrap.mjs`, `engine_facts.mjs`, `PIN`, or fake CLI fixtures) inside TypeScript packages with `"type": "module"` leads to two subtle failures:
1. `tsc -b` ignores non-TypeScript files in `src/`, leaving them missing from `dist/` and causing staged distribution bundles (`pnpm stage:desktop`) to fail at runtime when importing the vendored wrapper.
2. Extensionless Node executable fixtures using CommonJS (`const fs = require(...)`) crash with `ReferenceError: require is not defined in ES module scope` when executed inside a parent package marked `"type": "module"`.

**Root Cause:**
1. The TypeScript compiler only copies and emits files it compiles (`.ts`, `.tsx`). Static assets and plain `.mjs` vendor modules in `src/` must be explicitly copied to `dist/` via a post-compile script.
2. In Node.js, extensionless files inherit the module format (`commonjs` vs `module`) of the nearest enclosing `package.json`. If the parent package is `"type": "module"`, extensionless scripts are parsed as ES modules by default.

**Rule:**
1. Any package vendoring uncompiled `.mjs` or data files in `src/` must wire a post-build asset copy hook into its `"build"` script (e.g. `tsc -b && node scripts/copy-vendor-assets.mjs`) to guarantee assets reach `dist/` and downstream distributions.
2. Test fixture directories containing extensionless CommonJS scripts must include an isolated local `package.json` with `{ "type": "commonjs" }` to ensure Node executes them as CommonJS regardless of the parent repository's module type.
