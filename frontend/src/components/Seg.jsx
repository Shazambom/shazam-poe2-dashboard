import React from 'react'

// The app's segmented control: one of `options` ([key, label, ⌘K marker?]) is on. Reuses the `.seg` /
// `.seg-btn` classes the Hold and Economy pages already draw by hand.
export default function Seg({ value, options, onChange, title }) {
  return (
    <div className="seg" title={title}>
      {options.map(([k, label, cmd]) => (
        <button key={k} type="button" data-cmd={cmd} className={`seg-btn ${value === k ? 'on' : ''}`} onClick={() => onChange(k)}>{label}</button>
      ))}
    </div>
  )
}
