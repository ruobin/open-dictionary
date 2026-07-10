import type { Meaning } from '../api/dictionary'
import MoreExamplesButton from './MoreExamplesButton'
import { useI18n } from '../i18n/I18nContext'

export default function PosSection({
  meaning,
  word,
  sourceLang,
  targetLang,
}: {
  meaning: Meaning
  word: string
  sourceLang: string
  targetLang: string
}) {
  const { partOfSpeech, definitions = [], synonyms = [] } = meaning
  const { t } = useI18n()

  return (
    <section className="pos-section">
      <h3 className="pos-label">{partOfSpeech}</h3>
      <ol className="defs">
        {definitions.map((d, i) => (
          <li key={i} className="def-item">
            <div className="def-head">
              <p className="def-text">{d.definition}</p>
              {d.cefr && (
                <span className="cefr-badge" data-level={d.cefr}>
                  {d.cefr}
                </span>
              )}
            </div>
            {(d.grammar || d.register) && (
              <p className="def-labels">
                {d.grammar && <span className="def-label">{d.grammar}</span>}
                {d.register && <span className="def-label">{d.register}</span>}
              </p>
            )}
            {d.examples && d.examples.length > 0 && (
              <ul className="def-examples">
                {d.examples.map((ex, j) => (
                  <li key={j} className="def-example">
                    &quot;{ex.text}&quot;
                    {ex.cefr && (
                      <span className="cefr-badge cefr-badge-sm" data-level={ex.cefr}>
                        {ex.cefr}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <MoreExamplesButton
              word={word}
              sourceLang={sourceLang}
              targetLang={targetLang}
              definition={d.definition}
              cefr={d.cefr}
            />
          </li>
        ))}
      </ol>
      {synonyms.length > 0 && (
        <p className="synonyms">
          <span className="synonyms-label">{t('word.synonyms')}</span>{' '}
          {synonyms.slice(0, 8).join(', ')}
        </p>
      )}
    </section>
  )
}
