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

export default function Sidebar({
  history,
  favorites,
}: {
  history: string[]
  favorites: FavoriteKey[]
}) {
  const historyItems: SidebarItem[] = history
    .slice(0, 15)
    .map((w) => ({ key: w, to: `/word/${encodeURIComponent(w)}`, label: w }))

  const favoriteItems: SidebarItem[] = favorites.map((f) => ({
    key: `${f.word}|${f.sourceLang}|${f.targetLang}`,
    to: `/word/${encodeURIComponent(f.word)}?from=${f.sourceLang}&to=${f.targetLang}`,
    label: f.word,
    sub: `${f.sourceLang}\u2192${f.targetLang}`,
  }))

  return (
    <aside className="sidebar">
      <WordList title="Favorites" items={favoriteItems} emptyText="Star a translation to save it here." />
      <WordList title="Recent" items={historyItems} emptyText="Search a word to get started." />
    </aside>
  )
}
