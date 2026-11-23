import { it, expect } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import StratCalcView from '../../src/components/StratCalcView.jsx'
import { installApiMock } from './setup.js'

it('keeps the strategy tree mounted when a folder is added and removes it on unmount', async () => {
  const { calls } = installApiMock()
  const { container, rerender, unmount } = render(<StratCalcView />)
  const folder = await screen.findByRole('button', { name: 'New folder' })
  const tree = container.querySelector('.scalc-tree [role="tree"]')
  expect(tree).toBeTruthy()
  fireEvent.click(folder)
  rerender(<StratCalcView />)
  expect(container.querySelector('.scalc-tree [role="tree"]')).toBe(tree)
  expect(calls.filter(c => c.path === '/api/strategy/calc' && !c.url.includes('prices=1'))).toHaveLength(1)
  unmount()
  expect(container.querySelector('[role="tree"]')).toBeNull()
})
