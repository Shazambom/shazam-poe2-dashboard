import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles.css'
import { bootTheme } from './lib/themeStore.js'
import { installErrorRing } from './lib/errorRing.js'
installErrorRing()   // the last 100 renderer errors, carried by "Report a problem"
bootTheme()   // the last-used preset, before first paint (settings reconcile it a moment later)
createRoot(document.getElementById('root')).render(<App />)
