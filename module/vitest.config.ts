import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { spacetimedbModuleTestPlugin } from 'spacetimedb/server/test-utils/vitest';

// runs the module against SpacetimeDB's portable datastore - no server needed.
//
// the published test-utils bundle carries its own copy of the runtime, so a Range
// made by the module isn't `instanceof` the Range the harness checks for, and
// every multi-column range scan turns into a point lookup. pointing everything at
// the package's typescript sources gives the module and the harness one runtime.
// only the tests need this - a published module only ever has the one copy
const pkg = resolve(dirname(fileURLToPath(import.meta.url)), 'node_modules/spacetimedb');

export default defineConfig({
  plugins: [
    spacetimedbModuleTestPlugin(),
    {
      name: 'one-spacetimedb-runtime',
      enforce: 'pre',
      // the sources don't ship the datastore's wasm - the built package does
      transform(code, id) {
        if (id.endsWith('/test-utils/default_wasm_runtime.ts')) {
          return code.replace("'./portable-datastore-wasm/", `'${pkg}/dist/server/test-utils/portable-datastore-wasm/`);
        }
      },
    },
  ],
  // the package's sources are written for define-semantics class fields (they seal
  // objects in constructors), and don't ship a tsconfig to say so
  esbuild: { tsconfigRaw: { compilerOptions: { useDefineForClassFields: true } } },
  resolve: {
    alias: [
      { find: /^spacetimedb\/server\/test-utils$/, replacement: `${pkg}/src/server/test-utils/index.ts` },
      { find: /^spacetimedb\/server$/, replacement: `${pkg}/src/server/index.ts` },
      { find: /^spacetimedb$/, replacement: `${pkg}/src/index.ts` },
    ],
  },
});
