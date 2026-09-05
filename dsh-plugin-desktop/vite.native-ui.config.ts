import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { collectNativeUiOriginEscapes, nativeUiOriginEscapeMessage } from './scripts/verify-native-ui-subtree.ts'

const root = dirname(fileURLToPath(import.meta.url))
const uiRoot = resolve(root, 'src/native-ui')
const outDir = resolve(root, 'lib/native-ui')

/**
 * Post-build gate (#53): every built document must reference its assets
 * inside its own directory — its Chromium file:// origin — because the
 * release fuse set keeps GrantFileProtocolExtraPrivileges off, so a `../`
 * hop becomes a module CORS refusal and the window never boots on real
 * installs (dev binaries ship the fuse on, which hides it under xvfb).
 */
function fileOriginSubtreeGuard(): Plugin {
  return {
    name: 'dsh-native-ui-file-origin-subtree',
    closeBundle() {
      const escapes = collectNativeUiOriginEscapes(outDir)
      if (escapes.length > 0) throw new Error(nativeUiOriginEscapeMessage(escapes))
    },
  }
}

/** Build the Desktop-owned static native surfaces without network dependencies. */
export default defineConfig({
  plugins: [react(), tailwindcss(), fileOriginSubtreeGuard()],
  root: uiRoot,
  base: './',
  resolve: { alias: { '@': resolve(root, 'src/native-ui') } },
  build: {
    outDir,
    emptyOutDir: false,
    sourcemap: true,
    rollupOptions: {
      input: {
        recovery: resolve(uiRoot, 'recovery.html'),
        'profile-create': resolve(uiRoot, 'profile-create.html'),
        'sso-gate': resolve(uiRoot, 'sso-gate.html'),
        // Every entry lands at the native-ui ROOT next to assets/ — a
        // nested document would reference ../assets/* and sit outside its
        // own file:// origin once the release fuses apply (#53).
        'agent-browser': resolve(uiRoot, 'agent-browser.html'),
      },
    },
  },
})
