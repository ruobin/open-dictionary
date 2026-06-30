import { useAuth0 } from '@auth0/auth0-react'

export default function AuthButton() {
  const { isAuthenticated, isLoading, user, loginWithRedirect, logout } = useAuth0()

  if (isLoading) return <span className="auth-status">…</span>

  if (!isAuthenticated) {
    return (
      <button className="btn btn-primary" onClick={() => loginWithRedirect()}>
        Log in
      </button>
    )
  }

  return (
    <div className="user-chip">
      {user?.picture && <img src={user.picture} alt="" />}
      <span className="user-name">{user?.name || user?.email}</span>
      <button
        className="btn btn-ghost"
        onClick={() => logout({ logoutParams: { returnTo: window.location.origin } })}
      >
        Log out
      </button>
    </div>
  )
}
