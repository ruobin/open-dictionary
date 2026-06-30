import { useEffect } from 'react'
import { Route, Routes, useParams, useSearchParams } from 'react-router-dom'
import Header from './components/Header'
import SearchBar from './components/SearchBar'
import Sidebar from './components/Sidebar'
import WordEntry from './components/WordEntry'
import { useDictionary } from './hooks/useDictionary'
import { useUserData } from './hooks/useUserData'
import { useFavorites } from './hooks/useFavorites'
import type { FavoriteKey } from '../shared/favorites'

function Home() {
  return (
    <div className="home">
      <h1 className="home-title">Look up a word.</h1>
      <p className="home-sub">Definitions, pronunciation, and examples.</p>
      <div className="home-search">
        <SearchBar />
      </div>
    </div>
  )
}

function WordPage({
  userData,
  favorites,
}: {
  userData: ReturnType<typeof useUserData>
  favorites: ReturnType<typeof useFavorites>
}) {
  const { term } = useParams()
  const [searchParams] = useSearchParams()
  const word = (term || '').toLowerCase()
  const sourceLang = searchParams.get('from') || 'en'
  const targetLang = searchParams.get('to') || 'en'
  const { status, data, error } = useDictionary(word, sourceLang, targetLang)

  const favKey: FavoriteKey = { word, sourceLang, targetLang }

  useEffect(() => {
    if (status === 'success' && word) {
      userData.addToHistory(word)
    }
  }, [status, word, userData.addToHistory])

  return (
    <div className="word-page">
      <div className="word-page-search">
        <SearchBar
          initialValue={word}
          initialSourceLang={sourceLang}
          initialTargetLang={targetLang}
        />
      </div>

      {status === 'loading' && <p className="state-msg">Loading…</p>}

      {status === 'error' && error?.code === 'not_found' && (
        <div className="state-msg state-error">
          <h2>We couldn't find &quot;{word}&quot;</h2>
          <p>Check the spelling or try a different word.</p>
        </div>
      )}

      {status === 'error' && error?.code === 'timeout' && (
        <div className="state-msg state-error">
          <h2>The lookup timed out</h2>
          <p>The dictionary service is taking too long. Please try again.</p>
        </div>
      )}

      {status === 'error' && error?.code === 'network' && (
        <div className="state-msg state-error">
          <h2>Network problem</h2>
          <p>Couldn't reach the dictionary service. Check your connection and try again.</p>
        </div>
      )}

      {status === 'error' &&
        error !== null &&
        !['not_found', 'timeout', 'network'].includes(error.code) && (
          <div className="state-msg state-error">
            <h2>Something went wrong</h2>
            <p>Please try again in a moment.</p>
          </div>
        )}

      {status === 'success' && data && data.length > 0 && (
        <WordEntry
          entry={data[0]}
          isFavorite={favorites.isFavorite(favKey)}
          onToggleFavorite={() => favorites.toggle(favKey)}
        />
      )}
    </div>
  )
}

export default function App() {
  const userData = useUserData()
  const favorites = useFavorites()

  return (
    <div className="app-shell">
      <Header />
      <main className="app-main">
        <div className="content">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route
              path="/word/:term"
              element={<WordPage userData={userData} favorites={favorites} />}
            />
          </Routes>
        </div>
        <Sidebar history={userData.history} favorites={favorites.favorites} />
      </main>
    </div>
  )
}
