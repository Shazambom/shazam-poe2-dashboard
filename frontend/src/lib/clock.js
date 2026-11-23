import { useSyncExternalStore } from 'react'

const readTime = () => Date.now()
const subscribeOnRender = () => () => {}

export function useClockValue(select) {
  const read = () => select(readTime())
  return useSyncExternalStore(subscribeOnRender, read, read)
}

export function createClock() {
  let now = readTime()
  return {
    read: () => now,
    subscribe(running, notify) {
      const sample = () => { now = readTime(); notify() }
      sample()
      if (!running) return () => {}
      const timer = setInterval(sample, 1000)
      return () => clearInterval(timer)
    },
  }
}
