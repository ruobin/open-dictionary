import { lazy, Suspense } from 'react'
import { Route, Routes, useLocation } from 'react-router-dom'
import Header from './components/Header'
import Sidebar from './components/Sidebar'
import { useUserData } from './hooks/useUserData'
import { useFavorites } from './hooks/useFavorites'
import Home from './pages/Home'
import WordPage from './pages/WordPage'
import HistoryPage from './pages/HistoryPage'
import AboutPage from './pages/AboutPage'

const AdminApp = lazy(() => import('./pages/admin'))

function DictionaryApp() {
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
            <Route path="/history" element={<HistoryPage history={userData.history} />} />
            <Route path="/about" element={<AboutPage />} />
          </Routes>
        </div>
        <Sidebar history={userData.history} favorites={favorites.favorites} />
      </main>
    </div>
  )
}

export default function App() {
  const location = useLocation()
  const isAdmin = location.pathname === '/admin' || location.pathname.startsWith('/admin/')

  if (isAdmin) {
    return (
      <Suspense fallback={<div className="state-msg">Loading admin…</div>}>
        <AdminApp />
      </Suspense>
    )
  }

  return <DictionaryApp />
}

