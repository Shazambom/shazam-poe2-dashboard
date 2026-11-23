import { it, expect } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { installApiMock } from './setup.js'
import { useStatus } from '../../src/lib/statusStore.js'
import GoldValueSlider from '../../src/components/GoldValueSlider.jsx'

it('hydrates GoldValueSlider once and sends the pending slider value once on unmount', async () => {
  useStatus.setState({ settings: null })
  const { calls } = installApiMock()
  const { rerender, unmount } = render(<GoldValueSlider />)
  await waitFor(() => expect(useStatus.getState().settings).toBeTruthy())
  const slider = screen.getAllByRole('slider')[0]
  fireEvent.change(slider, { target: { value: '6' } })
  rerender(<GoldValueSlider />)
  expect(slider.value).toBe('6')
  expect(calls.filter(c => c.method === 'GET' && c.path === '/api/settings')).toHaveLength(1)
  unmount()
  await waitFor(() => {
    const writes = calls.filter(c => c.method === 'PUT' && c.path === '/api/settings')
    expect(writes).toHaveLength(1)
    expect(writes[0].body.patch.gold_value_per_1k).toBe(0.001)
  })
})
