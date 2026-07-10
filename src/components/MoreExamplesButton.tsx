import { useState, type FormEvent } from 'react'
import { fetchMoreExamples } from '../api/moreExamples'
import { useI18n } from '../i18n/I18nContext'
import type { GradedExample } from '../api/dictionary'

type Status = 'idle' | 'open' | 'loading' | 'done' | 'error'

export default function MoreExamplesButton({
  word,
  sourceLang,
  targetLang,
  definition,
  cefr,
}: {
  word: string
  sourceLang: string
  targetLang: string
  definition: string
  cefr?: string
}) {
  const [status, setStatus] = useState<Status>('idle')
  const [topic, setTopic] = useState('')
  const [results, setResults] = useState<GradedExample[]>([])
  const { t } = useI18n()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setStatus('loading')
    const examples = await fetchMoreExamples({
      word,
      sourceLang,
      targetLang,
      definition,
      topic: topic.trim() || undefined,
      cefr,
    })
    if (examples && examples.length > 0) {
      setResults(examples)
      setStatus('done')
    } else {
      setStatus('error')
    }
  }

  if (status === 'idle') {
    return (
      <button type="button" className="more-examples-toggle" onClick={() => setStatus('open')}>
        {t('moreExamples.cta')}
      </button>
    )
  }

  return (
    <div className="more-examples-widget">
      <form className="more-examples-form" onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder={t('moreExamples.topicPlaceholder')}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
        />
        <button type="submit" disabled={status === 'loading'}>
          {status === 'loading' ? t('moreExamples.generating') : t('moreExamples.getExamples')}
        </button>
      </form>
      {status === 'error' && <p className="more-examples-error">{t('moreExamples.error')}</p>}
      {status === 'done' && (
        <ul className="def-examples more-examples-results">
          {results.map((ex, i) => (
            <li key={i} className="def-example">
              &quot;{ex.text}&quot;
              {ex.cefr && (
                <span className="cefr-badge cefr-badge-sm" data-level={ex.cefr}>
                  {ex.cefr}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
