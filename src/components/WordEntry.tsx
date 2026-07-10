import AudioButton from './AudioButton'
import PosSection from './PosSection'
import ReportButton from './ReportButton'
import type { DictionaryEntry, Phonetic } from '../api/dictionary'

type PhoneticWithAudio = Phonetic & { audio: string }

interface AudioPick {
  uk: PhoneticWithAudio | undefined
  us: PhoneticWithAudio | undefined
  fallback: PhoneticWithAudio | undefined
}

function pickAudio(phonetics: Phonetic[]): AudioPick {
  const withAudio = phonetics.filter(
    (p): p is PhoneticWithAudio => Boolean(p.audio)
  )
  const uk = withAudio.find((p) => /-uk\.|\/uk\//i.test(p.audio))
  const us = withAudio.find((p) => /-us\.|\/us\//i.test(p.audio))
  const fallback = !uk && !us ? withAudio[0] : undefined
  return { uk, us, fallback }
}

function pickPhoneticText(phonetics: Phonetic[]): string {
  return phonetics.find((p) => p.text)?.text ?? ''
}

interface WordEntryProps {
  entry: DictionaryEntry
  sourceLang: string
  targetLang: string
  isFavorite: boolean
  onToggleFavorite: () => void
}

export default function WordEntry({
  entry,
  sourceLang,
  targetLang,
  isFavorite,
  onToggleFavorite,
}: WordEntryProps) {
  const phonetics = entry.phonetics ?? []
  const { uk, us, fallback } = pickAudio(phonetics)
  const phoneticText = pickPhoneticText(phonetics)

  return (
    <article className="word-entry">
      <header className="word-header">
        <div>
          <h1 className="headword">{entry.word}</h1>
          {phoneticText && <p className="phonetic">{phoneticText}</p>}
          {entry.translation && <p className="translation">{entry.translation}</p>}
        </div>
        <div className="word-actions">
          <div className="audio-row">
            {uk && <AudioButton label="UK" src={uk.audio} />}
            {us && <AudioButton label="US" src={us.audio} />}
            {fallback && <AudioButton label="Play" src={fallback.audio} />}
          </div>
          <button
            className={`fav-btn ${isFavorite ? 'is-fav' : ''}`}
            onClick={onToggleFavorite}
            aria-pressed={isFavorite}
            aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            type="button"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill={isFavorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
              <path d="M12 21s-7-4.35-9.5-9a5.5 5.5 0 0 1 9.5-5 5.5 5.5 0 0 1 9.5 5C19 16.65 12 21 12 21z" />
            </svg>
          </button>
        </div>
      </header>

      <div className="meanings">
        {(entry.meanings ?? []).map((m, i) => (
          <PosSection key={i} meaning={m} />
        ))}
      </div>

      {entry.examples && entry.examples.length > 0 && (
        <section className="more-examples">
          <h3 className="more-examples-label">More examples</h3>
          <ul className="more-examples-list">
            {entry.examples.map((ex, i) => (
              <li key={i}>&quot;{ex}&quot;</li>
            ))}
          </ul>
        </section>
      )}

      {entry.sourceUrls && entry.sourceUrls.length > 0 && (
        <footer className="word-footer">
          Source:{' '}
          {entry.sourceUrls.map((u, i) => (
            <a key={i} href={u} target="_blank" rel="noreferrer">{u}</a>
          ))}
        </footer>
      )}

      <div className="word-report-row">
        <ReportButton word={entry.word} sourceLang={sourceLang} targetLang={targetLang} />
      </div>
    </article>
  )
}
