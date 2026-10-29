import { useEffect } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import SearchBar from '../components/SearchBar'
import WordEntry from '../components/WordEntry'
import { LiveProvider, StreamCaret } from '../components/LiveText'
import { useDictionary } from '../hooks/useDictionary'
import { useDocumentMeta } from '../hooks/useDocumentMeta'
import { buildWordDescription, buildWordTitle } from '../../shared/seo'
import type { FavoriteKey } from '../../shared/favorites'
import type { useUserData } from '../hooks/useUserData'
import type { useFavorites } from '../hooks/useFavorites'
import { useI18n } from '../i18n/I18nContext'

export default function WordPage({
  userData,
  favorites,
}: {
  userData: ReturnType<typeof useUserData>
  favorites: ReturnType<typeof useFavorites>
}) {
  const { t } = useI18n()
  const { term } = useParams()
  const [searchParams] = useSearchParams()
  const word = (term || '').toLowerCase()
  const sourceLang = searchParams.get('from') || 'en'
  const targetLang = searchParams.get('to') || 'en'
  const { status, data, error, animate } = useDictionary(word, sourceLang, targetLang)

  const favKey: FavoriteKey = { word, sourceLang, targetLang }
  const entry = status === 'success' ? data?.[0] : undefined
  const isTypo = Boolean(entry?.typo?.suggestion)
  // While the server is still writing the entry, `data` holds a partial one.
  const streamingEntry = status === 'loading' ? data?.[0] : undefined
  const shownEntry = streamingEntry ?? (entry && !isTypo ? entry : undefined)

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
          title: word ? t('word.docTitleFallback', { word }) : t('home.docTitle'),
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

      {status === 'loading' && !streamingEntry && <p className="state-msg">{t('word.loading')}</p>}

      {status === 'error' && error?.code === 'not_found' && (
        <div className="state-msg state-error">
          <h2>{t('word.notFoundTitle', { word })}</h2>
          <p>{t('word.notFoundBody')}</p>
        </div>
      )}

      {status === 'error' && error?.code === 'timeout' && (
        <div className="state-msg state-error">
          <h2>{t('word.timeoutTitle')}</h2>
          <p>{t('word.timeoutBody')}</p>
        </div>
      )}

      {status === 'error' && error?.code === 'network' && (
        <div className="state-msg state-error">
          <h2>{t('word.networkTitle')}</h2>
          <p>{t('word.networkBody')}</p>
        </div>
      )}

      {status === 'error' &&
        error !== null &&
        !['not_found', 'timeout', 'network'].includes(error.code) && (
          <div className="state-msg state-error">
            <h2>{t('word.errorTitle')}</h2>
            <p>{t('word.errorBody')}</p>
          </div>
        )}

      {status === 'success' && data && data.length > 0 && data[0].typo?.suggestion && (
        <div className="state-msg typo-msg">
          <h2>
            {t('word.typoTitle', { word: data[0].word })}
          </h2>
          {data[0].typo.explanation && <p className="typo-explanation">{data[0].typo.explanation}</p>}
          <p>
            {t('word.typoDidYouMean')}{' '}
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

      {shownEntry && (
        // One WordEntry instance for the whole lookup (streaming -> done), so the
        // reveal animation carries on through completion instead of restarting.
        <LiveProvider value={{ animate, streaming: status === 'loading' }}>
          <div aria-busy={status === 'loading'}>
            <WordEntry
              key={word}
              entry={shownEntry}
              sourceLang={sourceLang}
              targetLang={targetLang}
              isFavorite={favorites.isFavorite(favKey)}
              onToggleFavorite={() => favorites.toggle(favKey)}
            />
            {status === 'loading' && (
              <p className="entry-pending">
                <StreamCaret />
              </p>
            )}
          </div>
        </LiveProvider>
      )}
    </div>
  )
}
