import '../shared/theme.css'
import './brand.css'
import { CSPProvider } from '@base-ui/react/csp-provider'
import { createRoot } from 'react-dom/client'
import { DisclaimerApp, DisclaimerErrorBoundary } from './App.tsx'

const root = document.getElementById('root')
if (root === null) throw new Error('dsh-disclaimer: root element is missing')
// The boundary keeps a crashing render a visible error card instead of a
// blank window (the sso gate's issue #36 lesson); main.tsx throws only when
// the root mount itself is impossible.
createRoot(root).render(
  <CSPProvider disableStyleElements>
    <DisclaimerErrorBoundary>
      <DisclaimerApp />
    </DisclaimerErrorBoundary>
  </CSPProvider>,
)
