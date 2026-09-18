// A number that counts up on mount (the board's little flourish when you come back to the tab —
// owner's call, kept on purpose; frontend/test/animated-number.test.mjs pins it), then rolls when
// its value changes between polls. Fast, stiff spring (~0.5s) so the count-up feels snappy, not a
// loading crawl. Plain createElement so node tests can render it without a JSX step.
import React, { useEffect } from 'react'
import { motion, useSpring, useTransform } from 'motion/react'

export const COUNT_UP_FROM = 0

export default function AnimatedNumber({ value, format }) {
  const sv = useSpring(COUNT_UP_FROM, { stiffness: 210, damping: 24, restDelta: 0.01 })
  useEffect(() => { sv.set(value) }, [value, sv])
  const text = useTransform(sv, v => format(v))
  return React.createElement(motion.span, null, text)
}
