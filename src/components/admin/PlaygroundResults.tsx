import { useState } from 'react'
import type { PlaygroundTargetResult } from '../../api/admin'
import WordEntry from '../WordEntry'

interface PlaygroundResultsProps {
  results: PlaygroundTargetResult[]
  sourceLang: string
  targetLang: string
}

export default function PlaygroundResults({ results, sourceLang, targetLang }: PlaygroundResultsProps) {
  return (
    <div className="admin-playground-results">
      {results.map((r) => (
        <PlaygroundResultCard key={`${r.providerId}::${r.model}`} result={r} sourceLang={sourceLang} targetLang={targetLang} />
      ))}
    </div>
  )
}

function PlaygroundResultCard({
  result,
  sourceLang,
  targetLang,
}: {
  result: PlaygroundTargetResult
  sourceLang: string
  targetLang: string
}) {
  const [view, setView] = useState<'rendered' | 'json'>('rendered')

  return (
    <div className="admin-card admin-playground-card">
      <div className="admin-card-header-row">
        <h2>{result.providerName} · {result.model}</h2>
        <span className="admin-hint">{result.ok ? `${result.ms} ms` : 'failed'}</span>
      </div>

      {!result.ok ? (
        <p className="admin-test-fail">Call failed{result.errorCode ? ` (${result.errorCode})` : ''}.</p>
      ) : (
        <>
          <div className="admin-page-actions">
            <button
              type="button"
              className={`btn btn-sm ${view === 'rendered' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setView('rendered')}
            >
              Rendered preview
            </button>
            <button
              type="button"
              className={`btn btn-sm ${view === 'json' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setView('json')}
            >
              Raw JSON
            </button>
            {result.tokensOut !== undefined && <span className="admin-hint">{result.tokensOut} tokens out</span>}
          </div>

          {view === 'rendered' ? (
            <div className="admin-entry-preview">
              {(result.entries ?? []).map((e, i) => (
                <WordEntry
                  key={i}
                  entry={e}
                  sourceLang={sourceLang}
                  targetLang={targetLang}
                  isFavorite={false}
                  onToggleFavorite={() => {}}
                />
              ))}
            </div>
          ) : (
            <pre className="admin-diff">{JSON.stringify(result.raw, null, 2)}</pre>
          )}
        </>
      )}
    </div>
  )
}
