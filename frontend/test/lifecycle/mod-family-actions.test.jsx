import { it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import ModTable from '../../src/components/ModTable.jsx'

it('toggles a modifier family and dispatches each expanded action to its affix', () => {
  const onToggle = vi.fn(), onTrade = vi.fn(), onStash = vi.fn()
  const family = { id: 'life', text: 'Maximum Life', tags: [], tiers: [] }
  render(<ModTable title="Prefixes" affix="prefix" rows={[{ family, n: 1, k: 1 }]}
    total={1} expanded={new Set(['life'])} onToggle={onToggle} onTrade={onTrade} onStash={onStash} />)
  const row = screen.getByRole('button', { name: /Maximum Life/ })
  fireEvent.click(screen.getByText('Maximum Life'))
  for (const key of ['Enter', ' ', 'Escape']) fireEvent.keyDown(row, { key })
  fireEvent.click(screen.getByRole('button', { name: 'Find in stash' }))
  fireEvent.click(screen.getByRole('button', { name: 'Search on trade' }))
  expect(onToggle.mock.calls).toEqual([['life'], ['life'], ['life'], ['life']])
  expect(onStash.mock.calls).toEqual([['prefix', 'life']])
  expect(onTrade.mock.calls).toEqual([['prefix', 'life']])
})
