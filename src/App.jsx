import { useEffect } from 'react'
import { Route, Routes, useParams } from 'react-router-dom'
import Header from './components/Header.jsx'
import SearchBar from './components/SearchBar.jsx'
import Sidebar from './components/Sidebar.jsx'
import WordEntry from './components/WordEntry.jsx'
import { useDictionary } from './hooks/useDictionary.js'
import { useUserData } from './hooks/useUserData.js'

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

function WordPage({ userData }) {
  const { term } = useParams()
  const word = (term || '').toLowerCase()
  const { status, data, error } = useDictionary(word)

  useEffect(() => {
    if (status === 'success' && word) {
      userData.addToHistory(word)
    }
  }, [status, word, userData])

  return (
    <div className="word-page">
      <div className="word-page-search">
        <SearchBar initialValue={word} />
      </div>

      {status === 'loading' && <p className="state-msg">Loading…</p>}

      {status === 'error' && error?.code === 'not_found' && (
        <div className="state-msg state-error">
          <h2>We couldn't find "{word}"</h2>
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

      {status === 'error' && !['not_found', 'timeout', 'network'].includes(error?.code) && (
        <div className="state-msg state-error">
          <h2>Something went wrong</h2>
          <p>Please try again in a moment.</p>
        </div>
      )}

      {status === 'success' && data && data.length > 0 && (
        <WordEntry
          entry={data[0]}
          isFavorite={userData.isFavorite(word)}
          onToggleFavorite={() => userData.toggleFavorite(word)}
        />
      )}
    </div>
  )
}

export default function App() {
  const userData = useUserData()

  return (
    <div className="app-shell">
      <Header />
      <main className="app-main">
        <div className="content">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/word/:term" element={<WordPage userData={userData} />} />
          </Routes>
        </div>
        <Sidebar history={userData.history} favorites={userData.favorites} />
      </main>
    </div>
  )
}
