import { defineConfig } from 'vite'

// Static site: deploy dist/ anywhere (IPFS, any static host). No server.
export default defineConfig({ base: './', build: { target: 'es2022' } })
