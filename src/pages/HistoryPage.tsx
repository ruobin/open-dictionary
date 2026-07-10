import { Link } from 'react-router-dom'
import type { FavoriteKey } from '../../shared/favorites'

export default function HistoryPage({ history }: { history: FavoriteKey[] }) {
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
