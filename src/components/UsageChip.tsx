import { useAuth0 } from '@auth0/auth0-react'
import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useUsage } from '../hooks/useUsage'
import { useI18n } from '../i18n/I18nContext'
import VerifyEmailCard from './VerifyEmailCard'

/**
 * Free new words left today (docs/design-llm-usage-quotas.md §4.6). Hidden
 * for the owner and unlimited accounts, while enforcement is off or in
 * shadow mode, and until it matters: after the day's first new word, or once
 * 30 % or less is left.
 */
export default function UsageChip() {
  const { usage } = useUsage()
  const { t } = useI18n()
  const { loginWithRedirect } = useAuth0()
  const location = useLocation()
  const [verifyOpen, setVerifyOpen] = useState(false)

  if (!usage || usage.enforcement !== 'on') return null
  const signIn = (): void => {
    void loginWithRedirect({ appState: { returnTo: `${location.pathname}${location.search}` } })
  }

  // The token was rejected (expired, revoked): ask for a fresh sign-in rather
  // than quietly spending the anonymous allowance.
  if (usage.authState === 'invalid') {
    return (
      <button type="button" className="usage-chip usage-chip-warn" onClick={signIn}>
        {t('usage.chipSignedOut')}
      </button>
    )
  }
  if (usage.tier === 'owner' || usage.tier === 'exempt' || !usage.today) return null

  const { used, limit, pool } = usage.today
  const left = Math.max(0, limit - used)
  const paused = usage.freeTier !== 'open'
  if (!paused && used === 0 && left > Math.floor(limit * 0.3)) return null

  const main = paused
    ? t('usage.chipPaused')
    : pool === 'account'
      ? t('usage.chipUsed', { used, limit })
      : t('usage.chipLeft', { left, limit })
  const unverified = usage.tier === 'user' && pool === 'ip'
  const hint =
    pool === 'ip' && usage.verifiedLimit
      ? unverified
        ? t('usage.chipVerifyFor', { limit: usage.verifiedLimit })
        : t('usage.chipSignInFor', { limit: usage.verifiedLimit })
      : null
  const className = `usage-chip ${paused || left === 0 ? 'usage-chip-warn' : ''}`
  const content = (
    <>
      <span>{main}</span>
      {hint && <span className="usage-chip-hint">{hint}</span>}
    </>
  )

  if (usage.tier === 'anon') {
    return (
      <button type="button" className={className} title={t('usage.chipHelp')} onClick={signIn}>
        {content}
      </button>
    )
  }
  if (unverified) {
    return (
      <span className="usage-chip-wrap">
        <button
          type="button"
          className={className}
          title={t('usage.chipHelp')}
          aria-expanded={verifyOpen}
          onClick={() => setVerifyOpen((open) => !open)}
        >
          {content}
        </button>
        {verifyOpen && (
          <div className="usage-popover">
            <VerifyEmailCard limit={usage.verifiedLimit ?? 20} />
          </div>
        )}
      </span>
    )
  }
  return (
    <span className={className} title={t('usage.chipHelp')}>
      {content}
    </span>
  )
}
