import '../shared/theme.css'
import { createRoot } from 'react-dom/client'
import { AgentBrowserApp } from './App.tsx'

const root = document.getElementById('root')
if (root === null) throw new Error('dsh-agent-browser: root element is missing')
createRoot(root).render(<AgentBrowserApp />)
