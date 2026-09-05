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
 * inside its own directory — its Chromium file:// origin. The release fuse
 * set now grants GrantFileProtocolExtraPrivileges (#54 final fix — without
 * it every packaged file:// page was an opaque null origin and no module
 * window booted), so this guard is defense-in-depth: same-directory
 * references never depend on the relaxed cross-directory reach, keeping
 * the least-privilege shape even though a `../` hop would currently load.
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
        // nested document would reference ../assets/* and depend on the
        // file-privilege fuse's relaxed cross-directory reach (#53/#54);
        // same-subtree references stay least-privilege and guard-checked.
        'agent-browser': resolve(uiRoot, 'agent-browser.html'),
      },
    },
  },
})
