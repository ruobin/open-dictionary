import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchWordOfDay } from '../api/wordOfDay'
import { lookupWord, type DictionaryEntry } from '../api/dictionary'
import { useI18n } from '../i18n/I18nContext'

export default function WordOfDay() {
  const { t } = useI18n()
  const [entry, setEntry] = useState<DictionaryEntry | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchWordOfDay(controller.signal).then((word) => {
      if (!word) return
      lookupWord(word, 'en', 'en')
        .then((data) => {
          if (data[0] && !data[0].typo) setEntry(data[0])
        })
        .catch(() => {})
    })
    return () => controller.abort()
  }, [])

  if (!entry) return null

  const firstDefinition = entry.meanings?.[0]?.definitions?.[0]?.definition

  return (
    <section className="word-of-day">
      <h2 className="word-of-day-label">{t('home.wordOfDay')}</h2>
      <Link to={`/word/${encodeURIComponent(entry.word)}`} className="word-of-day-word">
        {entry.word}
      </Link>
      {firstDefinition && <p className="word-of-day-def">{firstDefinition}</p>}
    </section>
  )
}
