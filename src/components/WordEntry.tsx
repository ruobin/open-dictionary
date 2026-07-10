import { Link } from 'react-router-dom'
import AudioButton from './AudioButton'
import PosSection from './PosSection'
import ReportButton from './ReportButton'
import { wordHref } from '../../shared/wordLink'
import { useI18n } from '../i18n/I18nContext'
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
  const { t } = useI18n()

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
            {uk && <AudioButton label={t('word.audioUk')} src={uk.audio} />}
            {us && <AudioButton label={t('word.audioUs')} src={us.audio} />}
            {fallback && <AudioButton label={t('word.audioPlay')} src={fallback.audio} />}
          </div>
          <button
            className={`fav-btn ${isFavorite ? 'is-fav' : ''}`}
            onClick={onToggleFavorite}
            aria-pressed={isFavorite}
            aria-label={isFavorite ? t('word.favRemove') : t('word.favAdd')}
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
          <PosSection key={i} meaning={m} word={entry.word} sourceLang={sourceLang} targetLang={targetLang} />
        ))}
      </div>

      {entry.commonMistakes && entry.commonMistakes.length > 0 && (
        <section className="common-mistakes">
          <h3 className="common-mistakes-label">{t('word.commonMistakes')}</h3>
          <ul className="common-mistakes-list">
            {entry.commonMistakes.map((m, i) => (
              <li key={i}>
                <span className="mistake-wrong">{m.wrong}</span>
                <span className="mistake-arrow" aria-hidden="true">→</span>
                <span className="mistake-right">{m.right}</span>
                {m.note && <p className="mistake-note">{m.note}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {entry.collocations && entry.collocations.length > 0 && (
        <section className="chips-section">
          <h3 className="chips-label">{t('word.collocations')}</h3>
          <div className="chips">
            {entry.collocations.map((c, i) => (
              <Link key={i} className="chip" to={wordHref(c)}>{c}</Link>
            ))}
          </div>
        </section>
      )}

      {entry.wordFamily && entry.wordFamily.length > 0 && (
        <section className="chips-section">
          <h3 className="chips-label">{t('word.wordFamily')}</h3>
          <div className="chips">
            {entry.wordFamily.map((w, i) => (
              <Link key={i} className="chip" to={wordHref(w)}>{w}</Link>
            ))}
          </div>
        </section>
      )}

      {entry.sourceUrls && entry.sourceUrls.length > 0 && (
        <footer className="word-footer">
          {t('word.source')}{' '}
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
