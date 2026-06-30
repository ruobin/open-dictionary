import { Link } from 'react-router-dom'
import AuthButton from './AuthButton'

export default function Header() {
  return (
    <header className="app-header">
      <Link to="/" className="brand">
        <span className="brand-mark">open</span>
        <span className="brand-name">·dictionary</span>
      </Link>
      <AuthButton />
    </header>
  )
}
