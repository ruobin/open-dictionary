import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import SearchBar from '../components/SearchBar'
import WordEntry from '../components/WordEntry'
import QuotaPanel from '../components/QuotaPanel'
import { LiveProvider, StreamCaret } from '../components/LiveText'
import { useDictionary } from '../hooks/useDictionary'
import { useUsage } from '../hooks/useUsage'
import { useAccessToken } from '../hooks/useAccessToken'
import { forgetCachedEntry, type DictionaryEntry, type GeneratedBy } from '../api/dictionary'
import { regenerateEntry } from '../api/usage'
import { useDocumentMeta } from '../hooks/useDocumentMeta'
import { buildWordDescription, buildWordTitle } from '../../shared/seo'
import type { FavoriteKey } from '../../shared/favorites'
import type { useUserData } from '../hooks/useUserData'
import type { useFavorites } from '../hooks/useFavorites'
import { useI18n } from '../i18n/I18nContext'

/** The cached entry wasn't written by the owner's current full setup (e.g. a stranger's metered model). */
function differsFromFullSetup(generatedBy: GeneratedBy | undefined, fullModels: string[] | undefined): boolean {
  if (!generatedBy || !fullModels || fullModels.length === 0) return false
  if (fullModels.length > 1) return !generatedBy.merged
  return generatedBy.models.length !== 1 || generatedBy.models[0] !== fullModels[0]
}

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
  const { status, data: lookedUp, error, animate } = useDictionary(word, sourceLang, targetLang)
  const { usage } = useUsage()
  const { getToken } = useAccessToken()

  // Owner Regenerate (docs/design-llm-usage-quotas.md §4.4): the fresh entry replaces the shown one.
  const [regenerated, setRegenerated] = useState<{ key: string; entries: DictionaryEntry[] } | null>(null)
  const [regenerating, setRegenerating] = useState<'idle' | 'busy' | 'failed'>('idle')
  const lookupKey = `${sourceLang}:${targetLang}:${word}`
  useEffect(() => setRegenerating('idle'), [lookupKey])
  const data = regenerated?.key === lookupKey ? regenerated.entries : lookedUp

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

  async function regenerate(): Promise<void> {
    setRegenerating('busy')
    const entries = await regenerateEntry(getToken, word, sourceLang, targetLang)
    if (entries && entries.length > 0) {
      forgetCachedEntry(word, sourceLang, targetLang)
      setRegenerated({ key: lookupKey, entries })
      setRegenerating('idle')
    } else {
      setRegenerating('failed')
    }
  }

  const regenerateAction =
    usage?.tier === 'owner' && status === 'success' && entry && !isTypo && differsFromFullSetup(entry.generatedBy, usage.fullModels) ? (
      regenerating === 'failed' ? (
        <span className="word-regenerate-failed">{t('word.regenerateFailed')}</span>
      ) : (
        <button type="button" className="word-regenerate" onClick={() => void regenerate()} disabled={regenerating === 'busy'}>
          {regenerating === 'busy' ? t('word.regenerating') : t('word.regenerate')}
        </button>
      )
    ) : null

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

      {status === 'error' && error?.code === 'quota_exceeded' && error.quota && <QuotaPanel quota={error.quota} />}

      {status === 'error' &&
        error !== null &&
        !['not_found', 'timeout', 'network', 'quota_exceeded'].includes(error.code) && (
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
              generatedByAction={regenerateAction}
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
