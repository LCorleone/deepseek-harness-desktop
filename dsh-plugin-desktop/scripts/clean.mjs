// Removes the whole `lib` tree so every build re-embeds a known desktop policy
// variant (scripts/embed-desktop-policy.mjs). Never preserve lib/policy here:
// a stale dev or release policy must not leak into the next build.
import { rmSync } from 'node:fs'

rmSync(new URL('../lib', import.meta.url), { recursive: true, force: true })
