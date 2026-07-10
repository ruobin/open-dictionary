import { useDocumentMeta } from '../hooks/useDocumentMeta'
import { useI18n } from '../i18n/I18nContext'

export default function AboutPage() {
  const { t } = useI18n()
  useDocumentMeta({
    title: t('about.docTitle'),
    description: t('about.docDescription'),
    canonical: `${window.location.origin}/about`,
  })

  return (
    <div className="about-page">
      <h1 className="page-title">{t('about.title')}</h1>

      <section className="about-section">
        <h2>{t('about.howTitle')}</h2>
        <p>{t('about.howP1')}</p>
        <p>{t('about.howP2')}</p>
      </section>

      <section className="about-section">
        <h2>{t('about.adsTitle')}</h2>
        <p>{t('about.adsP1')}</p>
      </section>

      <section className="about-section">
        <h2>{t('about.wrongTitle')}</h2>
        <p>
          {t('about.wrongP1a')}<strong>{t('about.wrongReportCta')}</strong>{t('about.wrongP1b')}
        </p>
      </section>

      <section className="about-section">
        <h2>{t('about.browseTitle')}</h2>
        <p>
          <a href="/browse/a">{t('about.browseLink')}</a>.
        </p>
      </section>
    </div>
  )
}
