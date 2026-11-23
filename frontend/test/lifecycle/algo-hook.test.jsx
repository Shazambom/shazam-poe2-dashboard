import { it, expect } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { installApiMock } from './setup.js'
import { useStatus } from '../../src/lib/statusStore.js'
import ArbitrageAlgorithm from '../../src/components/ArbitrageAlgorithm.jsx'

it('hydrates ArbitrageAlgorithm once and sends the pending slider value once on unmount', async () => {
  useStatus.setState({ settings: null })
  const { calls } = installApiMock()
  const { rerender, unmount } = render(<ArbitrageAlgorithm />)
  await waitFor(() => expect(useStatus.getState().settings).toBeTruthy())
  const slider = screen.getAllByRole('slider')[0]
  fireEvent.change(slider, { target: { value: '4' } })
  rerender(<ArbitrageAlgorithm />)
  expect(slider.value).toBe('4')
  expect(calls.filter(c => c.method === 'GET' && c.path === '/api/settings')).toHaveLength(1)
  unmount()
  await waitFor(() => {
    const writes = calls.filter(c => c.method === 'PUT' && c.path === '/api/settings')
    expect(writes).toHaveLength(1)
    expect(writes[0].body.patch.max_steps).toBe(4)
  })
})
