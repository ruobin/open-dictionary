import { useAuth0 } from '@auth0/auth0-react'
import { Link, useLocation } from 'react-router-dom'
import type { QuotaInfo } from '../api/usage'
import { useUsage } from '../hooks/useUsage'
import { useI18n } from '../i18n/I18nContext'
import VerifyEmailCard from './VerifyEmailCard'

type T = ReturnType<typeof useI18n>['t']

/** "2 h 15 min" until `resetAt`. */
export function formatWait(resetAt: string, t: T, now: number = Date.now()): string {
  const ms = Math.max(0, new Date(resetAt).getTime() - now)
  let h = Math.floor(ms / 3_600_000)
  let m = Math.ceil((ms % 3_600_000) / 60_000)
  if (m === 60) {
    h += 1
    m = 0
  }
  return h > 0 ? t('quota.hoursMinutes', { h, m }) : t('quota.minutes', { m: Math.max(1, m) })
}

/** The reset is more than a day and a half away: the monthly budget, not today's. */
function isMonthReset(resetAt: string): boolean {
  return new Date(resetAt).getTime() - Date.now() > 36 * 3_600_000
}

/**
 * Shown instead of an entry when a new word was refused
 * (docs/design-llm-usage-quotas.md §4.6): why, when it comes back, and what
 * the user can do now. Words already in the dictionary keep working.
 */
export default function QuotaPanel({ quota, compact = false }: { quota: QuotaInfo; compact?: boolean }) {
  const { t, locale } = useI18n()
  const { loginWithRedirect } = useAuth0()
  const { usage } = useUsage()
  const location = useLocation()
  const verifiedLimit = usage?.verifiedLimit ?? 20
  const time = formatWait(quota.resetAt, t)
  const date = new Date(quota.resetAt).toLocaleDateString(locale, { month: 'long', day: 'numeric', timeZone: 'UTC' })

  let title: string
  let body: string
  switch (quota.reason) {
    case 'anon_daily':
      title = t('quota.anonDailyTitle')
      body = t('quota.anonDailyBody', { limit: verifiedLimit })
      break
    case 'unverified_daily':
      title = t('quota.unverifiedDailyTitle')
      body = t('quota.unverifiedDailyBody', { limit: verifiedLimit })
      break
    case 'anon_share':
      title = t('quota.anonShareTitle')
      body = t('quota.anonShareBody', { time })
      break
    case 'user_daily':
      title = t('quota.userDailyTitle', { limit: quota.limit })
      body = t('quota.userDailyBody', { time })
      break
    case 'free_tier_budget':
      title = t('quota.budgetTitle')
      body = isMonthReset(quota.resetAt) ? t('quota.budgetMonthBody', { date }) : t('quota.budgetDayBody', { time })
      break
    default:
      title = t('quota.pausedTitle')
      body = t('quota.pausedBody')
  }

  const canSignIn = quota.actions.includes('sign_in')
  const canVerify = quota.actions.includes('verify_email')

  return (
    <div className={`quota-panel ${compact ? 'quota-panel-compact' : 'state-msg'}`} role="alert">
      {compact ? <p className="quota-panel-title">{title}</p> : <h2>{title}</h2>}
      <p>{body}</p>
      {!compact && <p className="quota-panel-free">{t('quota.alwaysFree')}</p>}
      {(canSignIn || !compact) && (
        <div className="quota-panel-actions">
          {canSignIn && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void loginWithRedirect({ appState: { returnTo: `${location.pathname}${location.search}` } })}
            >
              {t('quota.signIn')}
            </button>
          )}
          {!compact && (
            <Link className="btn btn-ghost" to="/browse/a">
              {t('quota.browse')}
            </Link>
          )}
        </div>
      )}
      {canVerify && <VerifyEmailCard limit={verifiedLimit} />}
    </div>
  )
}
