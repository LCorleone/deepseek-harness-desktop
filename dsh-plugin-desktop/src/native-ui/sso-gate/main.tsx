import '../shared/theme.css'
import { CSPProvider } from '@base-ui/react/csp-provider'
import { createRoot } from 'react-dom/client'
import { SsoGateApp } from './App.tsx'

const root = document.getElementById('root')
if (root === null) throw new Error('dsh-sso-gate: root element is missing')
createRoot(root).render(<CSPProvider disableStyleElements><SsoGateApp /></CSPProvider>)
