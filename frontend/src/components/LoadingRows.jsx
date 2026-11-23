// All three tables show the same fixed six placeholders before records arrive.
export default function LoadingRows({ columns, label }) {
  const row = <tr><td colSpan={columns} aria-label={label}><div className="sk sk-row" /></td></tr>
  return <tbody>{row}{row}{row}{row}{row}{row}</tbody>
}
