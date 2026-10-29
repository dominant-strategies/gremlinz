import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// Static site served by the board at its root: / (home), /hatch/ (launch flow), /forge/ (Gremlin Forge), and /assets/board-client.js
// (progressive enhancement for the board's server-rendered pages: sign in with Pelagus, post, comment, vote).
// public/assets/site.css keeps a fixed name (the board's own pages link it too), so pages link it with a content version:
// caches treat each version as a new file, and the board serves versioned requests as immutable.
const siteCssVersion = () => createHash('sha256').update(readFileSync(resolve(__dirname, 'public/assets/site.css'))).digest('hex').slice(0, 10)
const versionSiteCss = {
  name: 'version-site-css',
  transformIndexHtml: (html: string) => html.replaceAll('href="/assets/site.css"', `href="/assets/site.css?v=${siteCssVersion()}"`),
}

export default defineConfig({
  base: '/',
  // The Symbiosis SDK imports Node built-ins; its crypto dependencies also require vm.
  plugins: [
    versionSiteCss,
    nodePolyfills({
      include: ['crypto', 'assert', 'buffer', 'stream', 'util', 'process', 'events', 'vm'],
      globals: { Buffer: true, process: true },
    }),
  ],
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        home: resolve(__dirname, 'index.html'),
        hatch: resolve(__dirname, 'hatch/index.html'),
        docs: resolve(__dirname, 'docs/index.html'),
        forge: resolve(__dirname, 'forge/index.html'),
        'docs-economics': resolve(__dirname, 'docs/economics/index.html'),
        'board-client': resolve(__dirname, 'src/board-client.ts'),
      },
      output: {
        // The board links this by a fixed path, so it must not be content-hashed.
        entryFileNames: (chunk) => (chunk.name === 'board-client' ? 'assets/board-client.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
})
