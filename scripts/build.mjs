/** Build the host module and DSH browser closure factory using public dependencies. */
import { build, context } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { relative } from 'node:path'
import { transform } from 'lightningcss'

const root = fileURLToPath(new URL('../', import.meta.url))
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const mode = process.env.NODE_ENV ?? 'production'
const minify = mode === 'production'

// DSH owns these module identities; both artifacts resolve them from their host.
const external = ['@deepseek-ai/*', '@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*']
const shared = {
  absWorkingDir: root,
  bundle: true,
  target: 'es2024',
  sourcemap: true,
  minify,
  logLevel: 'info',
}

const cssModules = {
  name: 'dsh-mcp-manager-css',
  setup(builder) {
    builder.onLoad({ filter: /\.module\.css$/ }, async args => {
      const result = transform({
        filename: relative(root, args.path).replaceAll('\\', '/'),
        code: await readFile(args.path),
        cssModules: true,
        minify,
      })
      const classes = Object.fromEntries(Object.entries(result.exports).map(([key, value]) => [key, value.name]))
      return {
        loader: 'js',
        watchFiles: [args.path],
        contents: `
          let style = document.querySelector('style[data-dsh-mcp-manager]');
          if (!style) {
            style = document.createElement('style');
            style.dataset.dshMcpManager = '';
            document.head.appendChild(style);
          }
          style.textContent = ${JSON.stringify(result.code.toString())};
          export default ${JSON.stringify(classes)};
        `,
      }
    })
  },
}

const host = {
  ...shared,
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  format: 'esm',
  platform: 'node',
  external,
  define: { __DSH_MCP_MANAGER_VERSION__: JSON.stringify(pkg.version) },
}
const client = {
  ...shared,
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  external: [...external, 'react', 'react/*', 'react-dom', 'react-dom/*'],
  plugins: [cssModules],
  define: {
    'process.env.NODE_ENV': JSON.stringify(mode),
    'import.meta.env.MODE': JSON.stringify(mode),
    'import.meta.env': JSON.stringify({ MODE: mode }),
  },
  banner: { js: 'window.__ModuleLoader__.load({ id: "dsh-mcp-manager", factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;' },
  footer: { js: 'return module.exports; } });' },
}

if (process.argv.includes('--watch')) {
  const contexts = await Promise.all([context(host), context(client)])
  await Promise.all(contexts.map(value => value.watch()))
} else {
  await Promise.all([build(host), build(client)])
}
