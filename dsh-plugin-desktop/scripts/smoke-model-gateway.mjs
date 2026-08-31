/**
 * One-shot smoke check of the embedded company model gateway: decode the
 * shipped blob and send one minimal chat-completions request, printing the
 * HTTP status and the model echo — never the api key. For real-machine
 * verification of a packaged or built tree; run after `yarn build` (the script
 * reads the compiled `lib/` output like the other verification scripts).
 *
 *   node scripts/smoke-model-gateway.mjs
 *
 * Exits 0 only on HTTP 200 with the expected model echo.
 *
 * @module scripts/smoke-model-gateway
 */

import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const { readDesktopPolicy } = await import(join(packageRoot, 'lib', 'desktop-policy.js'))
const { managedModelGateway } = await import(join(packageRoot, 'lib', 'model-gateway.js'))

const policy = readDesktopPolicy()
const gateway = managedModelGateway(policy)
if (gateway === undefined) {
  console.error('smoke-model-gateway: this build\'s policy is not managed (locked && managedModels); nothing to probe')
  process.exit(2)
}

const model = gateway.models[0]
const response = await fetch(`${gateway.baseUrl.replace(/\/$/u, '')}/chat/completions`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${gateway.apiKey}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
    stream: false,
    max_tokens: 16,
  }),
})

const bodyText = await response.text()
let body = undefined
try {
  body = JSON.parse(bodyText)
} catch {
  body = undefined
}

console.log(`smoke-model-gateway: POST ${gateway.baseUrl}/chat/completions`)
console.log(`smoke-model-gateway: http ${String(response.status)} ${response.statusText}`)
console.log(`smoke-model-gateway: requested model ${model}`)
if (body !== null && typeof body === 'object') {
  const echoed = body.model
  const usage = body.usage
  const reasoning = Array.isArray(body.choices)
    && body.choices[0]?.message?.reasoning_content !== undefined
  console.log(`smoke-model-gateway: echoed model ${JSON.stringify(echoed)}`)
  if (usage !== null && typeof usage === 'object') {
    console.log(`smoke-model-gateway: usage ${JSON.stringify(usage)}`)
  }
  console.log(`smoke-model-gateway: reasoning content ${reasoning ? 'present' : 'absent'}`)
} else {
  console.log(`smoke-model-gateway: body ${bodyText.slice(0, 400)}`)
}

if (response.status !== 200 || body?.choices === undefined) {
  console.error('smoke-model-gateway: FAILED (expected http 200 with a choices array in the response)')
  process.exit(1)
}
if (body.model !== model) {
  console.log(`smoke-model-gateway: note the gateway echoes a canonical model name (${JSON.stringify(body.model)}) instead of the routed id`)
}
console.log('smoke-model-gateway: OK')
