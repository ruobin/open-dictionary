import { Link, useParams } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { fetchBrowsePage, type BrowseError, type BrowsePageData } from '../api/browse'
import { useDocumentMeta } from '../hooks/useDocumentMeta'
import { useI18n } from '../i18n/I18nContext'
import { wordHref } from '../../shared/wordLink'

type Status = 'loading' | 'success' | 'error'

/**
 * Client-side counterpart to scripts/render.ts's renderBrowsePage: the
 * statically prerendered `/browse/:letter` HTML (scripts/prerender.ts) is
 * only ever seen by crawlers/first paint — the CSR app replaces it on mount
 * (`createRoot`, not `hydrateRoot`; see scripts/render.ts's `injectPage` doc
 * comment), so without a real client-side route + data source here, a real
 * visitor following the "Browse all words alphabetically" link
 * (src/pages/AboutPage.tsx) would land on a blank page once the JS bundle
 * takes over. Fetches the same underlying data live via GET /api/browse/:letter
 * (server/browse.ts) instead of duplicating scripts/prerender.ts's HTML.
 */
export default function BrowsePage() {
  const { t } = useI18n()
  const { letter = '', page: pageParam } = useParams()
  const page = Math.max(parseInt(pageParam ?? '1', 10) || 1, 1)

  const [status, setStatus] = useState<Status>('loading')
  const [data, setData] = useState<BrowsePageData | null>(null)
  const [error, setError] = useState<BrowseError | null>(null)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    setStatus('loading')
    setData(null)
    setError(null)

    fetchBrowsePage(letter, page, controller.signal)
      .then((result) => {
        if (cancelled) return
        setData(result)
        setStatus('success')
      })
      .catch((err: BrowseError) => {
        if (cancelled) return
        setError(err)
        setStatus('error')
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [letter, page])

  useDocumentMeta(
    status === 'success' && data
      ? {
          title: `${t('browse.docTitlePrefix')}"${data.letter}"${
            data.totalPages > 1 ? ` (${t('browse.pageOf', { page: data.page, total: data.totalPages })})` : ''
          } — Open Dictionary`,
          description: t('browse.docDescription', { count: data.words.length, letter: data.letter }),
          canonical: `${window.location.origin}${
            data.page <= 1 ? `/browse/${data.letter}` : `/browse/${data.letter}/${data.page}`
          }`,
        }
      : { title: t('browse.docTitleFallback'), noindex: true }
  )

  return (
    <div className="browse-page">
      {status === 'loading' && <p className="state-msg">{t('common.loading')}</p>}

      {status === 'error' && error?.code === 'not_found' && (
        <div className="state-msg state-error">
          <h2>{t('browse.notFoundTitle')}</h2>
        </div>
      )}

      {status === 'error' && error?.code === 'network' && (
        <div className="state-msg state-error">
          <h2>{t('word.networkTitle')}</h2>
          <p>{t('word.networkBody')}</p>
        </div>
      )}

      {status === 'success' && data && (
        <>
          <h1 className="page-title">
            {t('browse.title', { letter: data.letter.toUpperCase() })}
          </h1>
          <nav className="browse-letters">
            {data.letters.map((l) => (
              <Link key={l} to={`/browse/${l}`} className={l === data.letter ? 'active' : undefined}>
                {l.toUpperCase()}
              </Link>
            ))}
          </nav>
          {data.words.length === 0 ? (
            <p className="state-msg">{t('browse.empty')}</p>
          ) : (
            <ul className="browse-word-list">
              {data.words.map((w) => (
                <li key={w}>
                  <Link to={wordHref(w)}>{w}</Link>
                </li>
              ))}
            </ul>
          )}
          <nav className="browse-pagination">
            {data.page > 1 && (
              <Link to={data.page - 1 <= 1 ? `/browse/${data.letter}` : `/browse/${data.letter}/${data.page - 1}`}>
                &laquo; {t('browse.previous')}
              </Link>
            )}
            {data.page < data.totalPages && (
              <Link to={`/browse/${data.letter}/${data.page + 1}`}>
                {t('browse.next')} &raquo;
              </Link>
            )}
          </nav>
        </>
      )}
    </div>
  )
}
