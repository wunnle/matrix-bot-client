import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync('./package.json', 'utf-8'))

/* Emits the built version as a tiny uncached file the running app can poll to
   notice it is out of date (see useAppVersion). Kept separate from index.html
   so the check costs a few bytes and never depends on parsing the shell. */
function versionManifest() {
  return {
    name: 'construct-version-manifest',
    generateBundle(this: { emitFile: (f: { type: 'asset'; fileName: string; source: string }) => void }) {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ version }),
      })
    },
  }
}

export default defineConfig({
  define: {
    __CONSTRUCT_VERSION__: JSON.stringify(version),
  },
  plugins: [react(), versionManifest()],
  optimizeDeps: {
    exclude: ['@matrix-org/matrix-sdk-crypto-wasm'],
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})
