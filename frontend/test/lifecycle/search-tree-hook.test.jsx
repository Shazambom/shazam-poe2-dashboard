import { it, expect, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import SearchTree from '../../src/components/SearchTree.jsx'
import { useWorkspace } from '../../src/lib/workspaceStore.js'

it('reads the stored folder state on mount and preserves the open tree across unrelated updates', () => {
  const child = { id: 'leaf', kind: 'search', name: 'Draft search' }
  const folder = { id: 'folder', kind: 'folder', name: 'Group', open: true, children: [child] }
  const prev = useWorkspace.getState()
  const select = vi.fn()
  try {
    useWorkspace.setState({ loaded: true, tree: [folder] })
    const { rerender, unmount } = render(<SearchTree onSelect={select} />)
    const leaf = screen.getByText('Draft search')
    act(() => useWorkspace.setState({ tree: [{ ...folder, open: false }] }))
    rerender(<SearchTree onSelect={select} />)
    expect(screen.getByText('Draft search')).toBe(leaf)
    unmount()
    expect(select).not.toHaveBeenCalled()
    expect(screen.queryByText('Draft search')).toBeNull()
  } finally {
    useWorkspace.setState(prev, true)
  }
})
