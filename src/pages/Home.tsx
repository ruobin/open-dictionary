import SearchBar from '../components/SearchBar'
import WordOfDay from '../components/WordOfDay'
import { useDocumentMeta } from '../hooks/useDocumentMeta'

export default function Home() {
  useDocumentMeta({
    title: 'open-dictionary — English Dictionary',
    description:
      'A clean, fast Cambridge-style English dictionary with pronunciation, examples, and per-user history and favorites.',
    canonical: window.location.origin + '/',
  })

  return (
    <div className="home">
      <h1 className="home-title">Look up a word.</h1>
      <p className="home-sub">Definitions, pronunciation, and examples.</p>
      <div className="home-search">
        <SearchBar />
      </div>
      <WordOfDay />
    </div>
  )
}
