import { Link } from 'react-router-dom'
import AuthButton from './AuthButton.jsx'

export default function Header() {
  return (
    <header className="app-header">
      <Link to="/" className="brand">
        <span className="brand-mark">ai</span>
        <span className="brand-name">·dic</span>
      </Link>
      <AuthButton />
    </header>
  )
}
