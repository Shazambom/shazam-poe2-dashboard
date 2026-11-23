import { it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import FeedbackDialog from '../../src/components/FeedbackDialog.jsx'

it('packages feedback once per open and restores focus while a late report settles', async () => {
  const opener = document.createElement('button')
  document.body.append(opener)
  opener.focus()
  const pending = Promise.withResolvers()
  const pack = vi.spyOn(window.poe2desktop.feedback, 'package').mockReturnValue(pending.promise)
  const close = vi.fn()
  try {
    const { rerender, unmount } = render(<FeedbackDialog onClose={close} />)
    rerender(<FeedbackDialog onClose={close} />)
    expect(pack).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(screen.getByTitle('Close (Esc)'))
    unmount()
    expect(document.activeElement).toBe(opener)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(close).not.toHaveBeenCalled()
    await act(async () => { pending.resolve({ shortId: 'late' }); await pending.promise })
    expect(screen.queryByRole('dialog')).toBeNull()
  } finally {
    opener.remove()
  }
})
