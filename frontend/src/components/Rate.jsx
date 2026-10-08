import React from 'react'
import Cur from './Cur.jsx'
import { fmt } from '../lib/api.js'
import { readable } from '../lib/price.js'

// THE way a price is drawn: the rate in its market (`num`), on the side that reads >= 1 (lib/price.js readable).
// "55.0 ◈" for a Divine in Chaos; "10.7 per ◈" for a Chaos in Divine. `value` is the rate of 1 of the card in `num`.
export default function Rate({ value, num, size = 14, bold = true, render }) {
  if (value == null) return <span className="muted">–</span>
  const { n, per } = readable(value)
  const num_ = render ? render(n) : fmt.rate(n)
  return <>{bold ? <b>{num_}</b> : num_}{per && <span className="per">per</span>}<Cur id={num} size={size} /></>
}
