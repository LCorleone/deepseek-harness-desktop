/** Embed the frozen guardrail prompt template into `lib/` as a build-time asset (#046). */

import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

// The frozen v1 template is a committed asset (byte-frozen by issue #046);
// unlike the catalog manifest there is no pipeline output candidate — the
// repository file IS the single source, and the copy below must stay
// byte-identical to it.
const source = join(packageRoot, 'assets', 'company-guardrail', 'prompt-template-v1.md')
const targetDirectory = join(packageRoot, 'lib', 'company-guardrail')

mkdirSync(targetDirectory, { recursive: true })
copyFileSync(source, join(targetDirectory, 'prompt-template-v1.md'))
console.log(`dsh-plugin-desktop: embedded the frozen guardrail prompt template at lib/company-guardrail/prompt-template-v1.md`)
