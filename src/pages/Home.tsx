import SearchBar from '../components/SearchBar'
import WordOfDay from '../components/WordOfDay'
import { useDocumentMeta } from '../hooks/useDocumentMeta'
import { useI18n } from '../i18n/I18nContext'

export default function Home() {
  const { t } = useI18n()
  useDocumentMeta({
    title: t('home.docTitle'),
    description: t('home.docDescription'),
    canonical: window.location.origin + '/',
  })

  return (
    <div className="home">
      <h1 className="home-title">{t('home.title')}</h1>
      <p className="home-sub">{t('home.subtitle')}</p>
      <div className="home-search">
        <SearchBar />
      </div>
      <WordOfDay />
    </div>
  )
}
