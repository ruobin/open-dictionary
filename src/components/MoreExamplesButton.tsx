import { useState, type FormEvent } from 'react'
import { fetchMoreExamples } from '../api/moreExamples'
import { useI18n } from '../i18n/I18nContext'
import { useAccessToken } from '../hooks/useAccessToken'
import type { GradedExample } from '../api/dictionary'
import type { QuotaInfo } from '../api/usage'
import QuotaPanel from './QuotaPanel'

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
  const [quota, setQuota] = useState<QuotaInfo | null>(null)
  const { t } = useI18n()
  const { getToken } = useAccessToken()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setStatus('loading')
    setQuota(null)
    const result = await fetchMoreExamples(
      {
        word,
        sourceLang,
        targetLang,
        definition,
        topic: topic.trim() || undefined,
        cefr,
      },
      getToken
    )
    if (result.ok) {
      setResults(result.examples)
      setStatus('done')
    } else {
      setQuota(result.quota ?? null)
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
      {status === 'error' && quota && <QuotaPanel quota={quota} compact />}
      {status === 'error' && !quota && <p className="more-examples-error">{t('moreExamples.error')}</p>}
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
