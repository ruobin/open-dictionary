import SearchBar from '../components/SearchBar'

export default function Home() {
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
