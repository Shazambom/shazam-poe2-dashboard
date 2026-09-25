import React from 'react'

// The app's segmented control: one of `options` ([key, label]) is on. Reuses the `.seg` /
// `.seg-btn` classes the Hold and Economy pages already draw by hand.
export default function Seg({ value, options, onChange, title }) {
  return (
    <div className="seg" title={title}>
      {options.map(([k, label]) => (
        <button key={k} type="button" className={`seg-btn ${value === k ? 'on' : ''}`} onClick={() => onChange(k)}>{label}</button>
      ))}
    </div>
  )
}
