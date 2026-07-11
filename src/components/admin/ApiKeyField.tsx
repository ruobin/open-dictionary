interface ApiKeyFieldProps {
  value: string
  onChange: (value: string) => void
  last4?: string
  id?: string
}

/** Write-only API key input — the server never sends the real key back, only
 *  a masked last4. Blank means "keep the currently stored key" on edit. */
export default function ApiKeyField({ value, onChange, last4, id }: ApiKeyFieldProps) {
  const placeholder = last4 ? `····${last4} — leave blank to keep` : 'sk-…'
  return (
    <input
      id={id}
      type="password"
      className="admin-input"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoComplete="off"
    />
  )
}
