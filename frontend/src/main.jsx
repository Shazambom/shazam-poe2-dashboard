import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles.css'
import { bootTheme } from './lib/themeStore.js'
bootTheme()   // the last-used preset, before first paint (settings reconcile it a moment later)
createRoot(document.getElementById('root')).render(<App />)
