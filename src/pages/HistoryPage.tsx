import { Link } from 'react-router-dom'
import { useDocumentMeta } from '../hooks/useDocumentMeta'
import type { FavoriteKey } from '../../shared/favorites'

export default function HistoryPage({ history }: { history: FavoriteKey[] }) {
  // Per-browser and not useful to search engines — keep it out of the index.
  useDocumentMeta({ title: 'History — Open Dictionary', noindex: true })

  return (
    <div className="history-page">
      <h1 className="page-title">History</h1>
      {history.length === 0 ? (
        <p className="state-msg">Search a word to get started.</p>
      ) : (
        <ul className="history-list">
          {history.map((e) => (
            <li key={`${e.word}|${e.sourceLang}|${e.targetLang}`}>
              <Link to={`/word/${encodeURIComponent(e.word)}?from=${e.sourceLang}&to=${e.targetLang}`}>
                <span className="history-word">{e.word}</span>
                <span className="history-sub">{e.sourceLang}→{e.targetLang}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
