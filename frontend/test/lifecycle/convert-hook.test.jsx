import { it, expect } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_CURRENCIES, installApiMock } from './setup.js'
import ConvertView from '../../src/components/ConvertView.jsx'

it('QA 1: Convert drops its last result when the currencies change (no stale route under new icons)', async () => {
  const { calls } = installApiMock()
  const { container, rerender, unmount } = render(<ConvertView currencies={DEFAULT_CURRENCIES} />)
  const amount = screen.getByRole('spinbutton')
  fireEvent.change(amount, { target: { value: '25' } })
  fireEvent.click(screen.getByRole('button', { name: 'Find route' }))
  await waitFor(() => expect(container.querySelector('.convert-result')).toBeTruthy())
  const input = container.querySelector('[data-cmd="convert-have"] input')
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: 'Vaal' } })
  fireEvent.mouseDown(container.querySelector('[data-cmd="convert-have"] .cmdk-item'))
  rerender(<ConvertView currencies={DEFAULT_CURRENCIES} />)
  expect(container.querySelector('.convert-result')).toBeNull()
  expect(amount.value).toBe('25')
  unmount()
  expect(calls.filter(c => c.path === '/api/convert')).toHaveLength(1)
})
