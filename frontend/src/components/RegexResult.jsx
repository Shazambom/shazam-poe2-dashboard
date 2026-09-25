import React from 'react'
import Toggle from './Toggle.jsx'
import { LIMIT, overLimit } from '../lib/regex/index.js'

// The search string and what to do with it: read it, copy it, hand it to the trade site, start
// over. Pinned above the controls. The count against the game's limit is the one readout.
export default function RegexResult({ lead, text, onCopy, onReset, onTrade, autoCopy, onAutoCopy, append, onAppend }) {
  const over = overLimit(text)
  return (
    <div className="rx-result rx-surface">
      <div className="rx-bar">
        {lead}
        <input className="rx-string" readOnly value={text} onFocus={e => e.target.select()} spellCheck={false}
               placeholder="Choose what to match below, then paste the string into the in-game search box." />
        <span className={`hint rx-len ${over ? 'over' : ''}`}>{text.length} / {LIMIT}</span>
        <button className="btn small primary" disabled={!text} onClick={onCopy}>Copy</button>
        {onTrade && <button className="btn small" onClick={onTrade}>Search on trade</button>}
        <button className="btn small" onClick={onReset}>Reset</button>
      </div>
      {over && <span className="warn-hint">Longer than the game accepts. Turn on Round to tens or remove a modifier.</span>}
      <details className="adv">
        <summary>Options</summary>
        <div className="rx-options">
          <Toggle checked={autoCopy} onChange={onAutoCopy} label="Copy on every change" />
          <div className="field">
            <label>Append to the string</label>
            <input value={append} onChange={e => onAppend(e.target.value)} spellCheck={false} />
          </div>
        </div>
      </details>
    </div>
  )
}
