import { Link } from 'react-router-dom'

function WordList({ title, words, emptyText }) {
  return (
    <section className="sidebar-section">
      <h4 className="sidebar-title">{title}</h4>
      {words.length === 0 ? (
        <p className="sidebar-empty">{emptyText}</p>
      ) : (
        <ul className="sidebar-list">
          {words.map((w) => (
            <li key={w}>
              <Link to={`/word/${encodeURIComponent(w)}`}>{w}</Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default function Sidebar({ history, favorites }) {
  return (
    <aside className="sidebar">
      <WordList
        title="Favorites"
        words={favorites}
        emptyText="Star a word to save it here."
      />
      <WordList
        title="Recent"
        words={history.slice(0, 15)}
        emptyText="Search a word to get started."
      />
    </aside>
  )
}
