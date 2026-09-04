import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    // Profile integration tests create a full package-junction closure; higher
    // Windows file concurrency makes their latency depend on NTFS/Defender load.
    maxWorkers: process.platform === 'win32' ? 2 : undefined,
    // Process the patched atomic-write package through the module graph
    // instead of native external imports, so tests/atomic-write-retry.spec.ts
    // can intercept its `node:fs/promises` rename boundary and script the
    // transient Windows EPERM/EACCES/EINVAL failures the yarn patch retries.
    server: {
      deps: {
        inline: ['@deepseek-ai/dsh-atomic-write'],
      },
    },
  },
})
