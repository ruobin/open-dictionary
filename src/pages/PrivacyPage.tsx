import { useDocumentMeta } from '../hooks/useDocumentMeta'
import { useI18n } from '../i18n/I18nContext'

/**
 * Privacy policy page (design doc §10 — required for Chrome Web Store
 * submission since the extension requests host permissions / handles user
 * data, even though that data is minimal). Lives at a stable URL on the
 * existing web app (`/privacy`) rather than only in the store listing, and
 * is linked from the extension's options page (`extension/src/options/
 * Options.tsx`).
 */
export default function PrivacyPage() {
  const { t } = useI18n()
  useDocumentMeta({
    title: t('privacy.docTitle'),
    description: t('privacy.docDescription'),
    canonical: `${window.location.origin}/privacy`,
  })

  return (
    <div className="about-page">
      <h1 className="page-title">{t('privacy.title')}</h1>

      <section className="about-section">
        <h2>{t('privacy.webTitle')}</h2>
        <p>{t('privacy.webP1')}</p>
        <p>{t('privacy.webP2')}</p>
      </section>

      <section className="about-section">
        <h2>{t('privacy.extTitle')}</h2>
        <p>{t('privacy.extP1')}</p>
        <p>{t('privacy.extP2')}</p>
      </section>

      <section className="about-section">
        <h2>{t('privacy.dataTitle')}</h2>
        <p>{t('privacy.dataP1')}</p>
      </section>
    </div>
  )
}
