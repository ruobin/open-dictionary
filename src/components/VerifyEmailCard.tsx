import { useAuth0 } from '@auth0/auth0-react'
import { useCallback, useEffect, useState } from 'react'
import { notifyUsageChanged, recheckEmailVerification, resendVerificationEmail } from '../api/usage'
import { useAccessToken } from '../hooks/useAccessToken'
import { useI18n } from '../i18n/I18nContext'

type Status =
  | 'idle'
  | 'sending'
  | 'sent'
  | 'rate_limited'
  | 'unavailable'
  | 'already_verified'
  | 'checking'
  | 'verified'
  | 'not_yet'

/**
 * "Verify your email to get N new words a day" (docs/design-llm-usage-quotas.md
 * §4.6). The server checks verification with Auth0 itself, so "I've verified"
 * just asks it to look again; it also looks again when the tab regains focus
 * (the user is usually coming back from their inbox).
 */
export default function VerifyEmailCard({ limit }: { limit: number }) {
  const { user } = useAuth0()
  const { getToken } = useAccessToken()
  const { t } = useI18n()
  const [status, setStatus] = useState<Status>('idle')

  const check = useCallback(
    async (quiet: boolean) => {
      if (!quiet) setStatus('checking')
      const verified = await recheckEmailVerification(getToken)
      if (verified) {
        setStatus('verified')
        notifyUsageChanged()
      } else if (!quiet) {
        setStatus('not_yet')
      }
    },
    [getToken]
  )

  useEffect(() => {
    const onFocus = (): void => {
      void check(true)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [check])

  async function resend(): Promise<void> {
    setStatus('sending')
    const result = await resendVerificationEmail(getToken)
    setStatus(result)
    if (result === 'already_verified') notifyUsageChanged()
  }

  if (status === 'verified') {
    return (
      <div className="verify-card" role="status">
        <p className="verify-card-done">{t('verify.done', { limit })}</p>
      </div>
    )
  }

  const message =
    status === 'sent'
      ? t('verify.sent')
      : status === 'rate_limited'
        ? t('verify.rateLimited')
        : status === 'unavailable'
          ? t('verify.unavailable')
          : status === 'already_verified'
            ? t('verify.alreadyVerified')
            : status === 'not_yet'
              ? t('verify.notYet')
              : null

  return (
    <div className="verify-card">
      <h3 className="verify-card-title">{t('verify.title')}</h3>
      <p>{user?.email ? t('verify.body', { email: user.email, limit }) : t('verify.bodyNoEmail', { limit })}</p>
      <div className="verify-card-actions">
        <button type="button" className="btn btn-primary" onClick={() => void check(false)} disabled={status === 'checking'}>
          {status === 'checking' ? t('verify.checking') : t('verify.check')}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => void resend()} disabled={status === 'sending'}>
          {status === 'sending' ? t('verify.sending') : t('verify.resend')}
        </button>
      </div>
      {message && (
        <p className="verify-card-note" role="status">
          {message}
        </p>
      )}
    </div>
  )
}
