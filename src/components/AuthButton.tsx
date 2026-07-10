import { useAuth0 } from '@auth0/auth0-react'
import { useI18n } from '../i18n/I18nContext'

export default function AuthButton() {
  const { isAuthenticated, isLoading, user, loginWithRedirect, logout } = useAuth0()
  const { t } = useI18n()

  if (isLoading) return <span className="auth-status">{t('auth.loading')}</span>

  if (!isAuthenticated) {
    return (
      <button className="btn btn-primary" onClick={() => loginWithRedirect()}>
        {t('auth.login')}
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
        {t('auth.logout')}
      </button>
    </div>
  )
}
