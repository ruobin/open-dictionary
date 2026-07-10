import { useState, type FormEvent } from 'react'
import { fetchMoreExamples } from '../api/moreExamples'
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
        More examples like this
      </button>
    )
  }

  return (
    <div className="more-examples-widget">
      <form className="more-examples-form" onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="Topic (optional), e.g. football"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
        />
        <button type="submit" disabled={status === 'loading'}>
          {status === 'loading' ? 'Generating…' : 'Get examples'}
        </button>
      </form>
      {status === 'error' && <p className="more-examples-error">Couldn&apos;t generate examples — try again.</p>}
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
