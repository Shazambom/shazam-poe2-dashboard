import { it, expect } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { installApiMock } from './setup.js'
import AccountsPanel from '../../src/components/AccountsPanel.jsx'

it('reads the OAuth result on mount and preserves the cookie draft through rerenders', () => {
  const url = window.location.href
  const { calls } = installApiMock()
  try {
    window.history.replaceState(null, '', '?oauth=error&msg=expired')
    const { rerender, unmount } = render(<AccountsPanel />)
    expect(screen.getByText('Login failed: expired')).toBeTruthy()
    const input = screen.getByPlaceholderText('POESESSID')
    fireEvent.change(input, { target: { value: 'draft' } })
    window.history.replaceState(null, '', '?oauth=ok')
    rerender(<AccountsPanel />)
    expect(input.value).toBe('draft')
    expect(screen.getByText('Login failed: expired')).toBeTruthy()
    unmount()
    expect(calls).toHaveLength(0)
  } finally {
    window.history.replaceState(null, '', url)
  }
})
