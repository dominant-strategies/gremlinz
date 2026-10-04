import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// Static site served by the board at its root: / (home), /hatch/ (launch flow), and /assets/board-client.js
// (progressive enhancement for the board's server-rendered pages: sign in with Pelagus, post, comment, vote).
export default defineConfig({
  base: '/',
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        home: resolve(__dirname, 'index.html'),
        hatch: resolve(__dirname, 'hatch/index.html'),
        'board-client': resolve(__dirname, 'src/board-client.ts'),
      },
      output: {
        // The board links this by a fixed path, so it must not be content-hashed.
        entryFileNames: (chunk) => (chunk.name === 'board-client' ? 'assets/board-client.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
})
