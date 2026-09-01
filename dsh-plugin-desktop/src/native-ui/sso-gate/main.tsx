import '../shared/theme.css'
import { CSPProvider } from '@base-ui/react/csp-provider'
import { createRoot } from 'react-dom/client'
import { SsoGateApp, SsoGateErrorBoundary } from './App.tsx'

const root = document.getElementById('root')
if (root === null) throw new Error('dsh-sso-gate: root element is missing')
// The boundary keeps a crashing render a visible error card instead of a
// blank window (issue #36); main.tsx throws only when the root mount itself
// is impossible.
createRoot(root).render(
  <CSPProvider disableStyleElements>
    <SsoGateErrorBoundary>
      <SsoGateApp />
    </SsoGateErrorBoundary>
  </CSPProvider>,
)
