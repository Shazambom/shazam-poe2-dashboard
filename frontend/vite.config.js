import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { presetTables } from './src/lib/themeCss.js'

// Pre-extract the shipped theme preset token tables from styles.css at build/dev time
// so ThemeBuilder loads a ~2 KB JSON module instead of bundling 100 KB of raw CSS into JS.
function themePresetsPlugin() {
  const id = 'virtual:theme-presets'
  const resolved = '\0' + id
  return {
    name: 'theme-presets',
    resolveId(source) { return source === id ? resolved : null },
    load(source) {
      if (source !== resolved) return null
      const css = readFileSync(new URL('./src/styles.css', import.meta.url), 'utf8')
      return `export default ${JSON.stringify(presetTables(css).tables)}\n`
    },
  }
}

export default defineConfig({
  plugins: [react(), themePresetsPlugin()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:8000', '/callback': 'http://localhost:8000' } },
  test: {
    environment: 'happy-dom',
    include: ['test/lifecycle/**/*.test.jsx'],
    setupFiles: ['test/lifecycle/setup.js'],
  },
})
