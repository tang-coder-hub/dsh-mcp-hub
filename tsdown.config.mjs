/**
 * Build configuration for dsh-mcp-hub.
 *
 * Dependency-free on purpose: a locally linked plugin resolves bare specifiers
 * from its own directory, so the config does not import `tsdown` and exports a
 * plain array.
 *
 *  - `lib/index.js`  — host half (Node ESM, builtins only)
 *  - `lib/client.js` — browser half, wrapped in the harness module loader
 *    envelope with React left external.
 */

/** Browser platform modules answered by the harness web loader table. */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

const CLIENT_EXTERNALS = [...PLATFORM_MODULES, '@deepseek-ai/dsh-client-runtime/client']

/** Must match package.json `name` — the harness loads client.js by package id. */
const CLIENT_MODULE_ID = 'dsh-mcp-hub'

export default [
  {
    name: 'host',
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    dts: false,
    clean: false,
    fixedExtension: false,
    minify: false,
  },
  {
    name: 'client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    dts: false,
    minify: false,
    sourcemap: false,
    clean: false,
    external: CLIENT_EXTERNALS,
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    noExternal: (id) => !CLIENT_EXTERNALS.includes(id),
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_MODULE_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
]
