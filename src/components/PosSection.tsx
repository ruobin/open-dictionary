import type { Meaning } from '../api/dictionary'

export default function PosSection({ meaning }: { meaning: Meaning }) {
  const { partOfSpeech, definitions = [], synonyms = [] } = meaning

  return (
    <section className="pos-section">
      <h3 className="pos-label">{partOfSpeech}</h3>
      <ol className="defs">
        {definitions.map((d, i) => (
          <li key={i} className="def-item">
            <p className="def-text">{d.definition}</p>
            {d.example && <p className="def-example">&quot;{d.example}&quot;</p>}
          </li>
        ))}
      </ol>
      {synonyms.length > 0 && (
        <p className="synonyms">
          <span className="synonyms-label">Synonyms:</span>{' '}
          {synonyms.slice(0, 8).join(', ')}
        </p>
      )}
    </section>
  )
}
