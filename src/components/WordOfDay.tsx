import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchWordOfDay } from '../api/wordOfDay'
import { lookupWord, type DictionaryEntry } from '../api/dictionary'

export default function WordOfDay() {
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
      <h2 className="word-of-day-label">Word of the day</h2>
      <Link to={`/word/${encodeURIComponent(entry.word)}`} className="word-of-day-word">
        {entry.word}
      </Link>
      {firstDefinition && <p className="word-of-day-def">{firstDefinition}</p>}
    </section>
  )
}
