import { Link } from 'react-router-dom'
import type { FavoriteKey } from '../../shared/favorites'

interface SidebarItem {
  key: string
  to: string
  label: string
  sub?: string
}

function WordList({
  title,
  items,
  emptyText,
}: {
  title: string
  items: SidebarItem[]
  emptyText: string
}) {
  return (
    <section className="sidebar-section">
      <h4 className="sidebar-title">{title}</h4>
      {items.length === 0 ? (
        <p className="sidebar-empty">{emptyText}</p>
      ) : (
        <ul className="sidebar-list">
          {items.map((item) => (
            <li key={item.key}>
              <Link to={item.to}>
                <span className="sidebar-word">{item.label}</span>
                {item.sub && <span className="sidebar-sub">{item.sub}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function historyItems(entries: FavoriteKey[]): SidebarItem[] {
  return entries.map((e) => ({
    key: `${e.word}|${e.sourceLang}|${e.targetLang}`,
    to: `/word/${encodeURIComponent(e.word)}?from=${e.sourceLang}&to=${e.targetLang}`,
    label: e.word,
    sub: `${e.sourceLang}\u2192${e.targetLang}`,
  }))
}

function favoriteItems(entries: FavoriteKey[]): SidebarItem[] {
  return entries.map((f) => ({
    key: `${f.word}|${f.sourceLang}|${f.targetLang}`,
    to: `/word/${encodeURIComponent(f.word)}?from=${f.sourceLang}&to=${f.targetLang}`,
    label: f.word,
    sub: `${f.sourceLang}\u2192${f.targetLang}`,
  }))
}

export default function Sidebar({
  history,
  favorites,
}: {
  history: FavoriteKey[]
  favorites: FavoriteKey[]
}) {
  return (
    <aside className="sidebar">
      <WordList
        title="Favorites"
        items={favoriteItems(favorites)}
        emptyText="Star a translation to save it here."
      />
      <WordList
        title="Recent"
        items={historyItems(history.slice(0, 15))}
        emptyText="Search a word to get started."
      />
    </aside>
  )
}
