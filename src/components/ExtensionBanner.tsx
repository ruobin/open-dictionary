import { useI18n } from '../i18n/I18nContext'
import { useDismissible } from '../hooks/useDismissible'

/** Chrome Web Store listing for the companion browser extension
 *  (see extension/README.md / extension/STORE_LISTING.md). */
export const EXTENSION_STORE_URL =
  'https://chromewebstore.google.com/detail/open-dictionary/hfolkjeiopiamogledcenajodmheanka'

const DISMISS_KEY = 'ext-banner-dismissed'

/** Dismissible top banner promoting the Chrome extension. Shown on every
 *  non-admin route (rendered once in App.tsx, above the header) until the
 *  user dismisses it; the choice persists in localStorage so it doesn't
 *  reappear on later visits. No install-state detection — it's shown to
 *  everyone regardless of whether the extension is already installed. */
export default function ExtensionBanner() {
  const { t } = useI18n()
  const [dismissed, dismiss] = useDismissible(DISMISS_KEY)

  if (dismissed) return null

  return (
    <div className="ext-banner" role="region" aria-label={t('banner.extensionTitle')}>
      <p className="ext-banner-text">
        <strong>{t('banner.extensionTitle')}</strong> {t('banner.extensionBody')}
      </p>
      <div className="ext-banner-actions">
        <a
          className="btn btn-primary ext-banner-cta"
          href={EXTENSION_STORE_URL}
          target="_blank"
          rel="noreferrer"
        >
          {t('banner.extensionCta')}
        </a>
        <button
          type="button"
          className="icon-btn ext-banner-dismiss"
          onClick={dismiss}
          aria-label={t('banner.extensionDismiss')}
          title={t('banner.extensionDismiss')}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  )
}
