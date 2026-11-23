import { it, expect } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { installApiMock } from './setup.js'
import RecipesView from '../../src/components/RecipesView.jsx'

it('loads recipes once and flushes the current recipe name when leaving the editor', async () => {
  const { calls } = installApiMock({ 'GET /api/recipes': [
    { id: 'r', name: 'Original', kind: 'combine', inputs: { chaos: 3 }, outputs: { divine: 1 } },
  ] })
  const { rerender, unmount } = render(<RecipesView />)
  const name = await screen.findByDisplayValue('Original')
  fireEvent.change(name, { target: { value: 'Draft' } })
  rerender(<RecipesView embedded />)
  expect(name.value).toBe('Draft')
  expect(calls.filter(c => c.path === '/api/recipes' && c.method === 'GET')).toHaveLength(1)
  unmount()
  await waitFor(() => expect(calls.filter(c => c.path === '/api/recipes' && c.method === 'PUT')).toHaveLength(1))
  expect(JSON.stringify(calls.find(c => c.method === 'PUT').body)).toContain('"name":"Draft"')
})
