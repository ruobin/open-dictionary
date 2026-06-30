import { Route, Routes } from 'react-router-dom'
import Header from './components/Header'
import Sidebar from './components/Sidebar'
import { useUserData } from './hooks/useUserData'
import { useFavorites } from './hooks/useFavorites'
import Home from './pages/Home'
import WordPage from './pages/WordPage'

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
            <Route path="/word/:term" element={<WordPage />} />
          </Routes>
        </div>
        <Sidebar history={userData.history} favorites={favorites.favorites} />
      </main>
    </div>
  )
}
