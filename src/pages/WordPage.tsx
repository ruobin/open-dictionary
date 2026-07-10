import { useEffect } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import SearchBar from '../components/SearchBar'
import WordEntry from '../components/WordEntry'
import { useDictionary } from '../hooks/useDictionary'
import { useDocumentMeta } from '../hooks/useDocumentMeta'
import { buildWordDescription, buildWordTitle } from '../../shared/seo'
import type { FavoriteKey } from '../../shared/favorites'
import type { useUserData } from '../hooks/useUserData'
import type { useFavorites } from '../hooks/useFavorites'

export default function WordPage({
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
  const entry = status === 'success' ? data?.[0] : undefined
  const isTypo = Boolean(entry?.typo?.suggestion)

  useEffect(() => {
    if (status === 'success' && word) {
      userData.addToHistory(word, sourceLang, targetLang)
    }
  }, [status, word, sourceLang, targetLang, userData.addToHistory])

  useDocumentMeta(
    entry && !isTypo
      ? {
          title: buildWordTitle(entry.word),
          description: buildWordDescription(entry.meanings?.[0]?.definitions?.[0]?.definition, entry.word),
          // en→en canonical only (to-do §5) — translation-pair query variants
          // all canonicalize back to the plain /word/:term path.
          canonical: `${window.location.origin}/word/${encodeURIComponent(entry.word)}`,
        }
      : {
          title: word ? `${word} — Open Dictionary` : 'open-dictionary — English Dictionary',
          noindex: true,
        }
  )

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

      {status === 'success' && data && data.length > 0 && data[0].typo?.suggestion && (
        <div className="state-msg typo-msg">
          <h2>
            &quot;{data[0].word}&quot; looks like a typo
          </h2>
          {data[0].typo.explanation && <p className="typo-explanation">{data[0].typo.explanation}</p>}
          <p>
            Did you mean{' '}
            <a
              className="typo-suggestion"
              href={`/word/${encodeURIComponent(data[0].typo.suggestion.toLowerCase())}${
                sourceLang !== 'en' || targetLang !== 'en'
                  ? `?${new URLSearchParams({
                      ...(sourceLang !== 'en' ? { from: sourceLang } : {}),
                      ...(targetLang !== 'en' ? { to: targetLang } : {}),
                    }).toString()}`
                  : ''
              }`}
            >
              {data[0].typo.suggestion}
            </a>
            ?
          </p>
        </div>
      )}

      {status === 'success' && data && data.length > 0 && !data[0].typo?.suggestion && (
        <WordEntry
          entry={data[0]}
          sourceLang={sourceLang}
          targetLang={targetLang}
          isFavorite={favorites.isFavorite(favKey)}
          onToggleFavorite={() => favorites.toggle(favKey)}
        />
      )}
    </div>
  )
}
