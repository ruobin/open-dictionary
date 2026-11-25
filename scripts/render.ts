import type { DictionaryEntry } from '../server/translate'
import type { TranslationDoc } from '../server/cache/translationCache'
import { isListableTerm, sameTerm } from '../shared/term'
import { buildWordDescription, buildWordTitle } from '../shared/seo'
import { wordHref } from '../shared/wordLink'
import { bucketLetter, paginate, WORDS_PER_BROWSE_PAGE } from '../shared/browse'

/**
 * Pure HTML-building helpers for scripts/prerender.ts. Kept dependency-free
 * (no Mongo/fs) so they're unit-testable like the rest of this codebase's
 * pure functions.
 */

export { bucketLetter, paginate, WORDS_PER_BROWSE_PAGE }

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function pickFirstDefinition(entry: DictionaryEntry): string | undefined {
  return entry.meanings?.[0]?.definitions?.[0]?.definition
}

export interface RenderedPage {
  title: string
  description: string
  canonical: string
  bodyHtml: string
  jsonLd?: Record<string, unknown>
  noindex?: boolean
}

/**
 * What one cache doc publishes as a static word page: the term its path, URL
 * and browse listing use, and the entry to render. `null` when the doc has
 * nothing to publish (typo-only, no senses); `'unlisted'` when its term is not
 * one to show publicly: it cannot be a path segment, or it does not look like
 * a headword or short phrase (`isListableTerm`), which keeps pasted sentences,
 * addresses and numbers off the static site and out of the sitemap.
 *
 * The term is the cache key (`doc.word`), never `entry.word`: for an LLM entry
 * that is the model's echo of the term and is untrusted, so trusting it would
 * let one entry overwrite another word's page. The headword is shown only when
 * it is the same term in another case ("Paris" for "paris").
 */
export function wordPageFor(
  doc: Pick<TranslationDoc, 'word' | 'entries'>
): { term: string; entry: DictionaryEntry } | 'unlisted' | null {
  const entry: DictionaryEntry | undefined = doc.entries[0]
  if (!entry || entry.typo || !entry.meanings.length) return null
  const term = doc.word
  if (!isListableTerm(term)) return 'unlisted'
  return { term, entry: sameTerm(entry.word, term) ? entry : { ...entry, word: term } }
}

function renderChips(items: string[] | undefined): string {
  if (!items || items.length === 0) return ''
  return `<div class="chips">${items
    .map((item) => `<a class="chip" href="${escapeHtml(wordHref(item))}">${escapeHtml(item)}</a>`)
    .join('')}</div>`
}

/** Server-rendered content mirroring src/components/WordEntry.tsx +
 *  PosSection.tsx, minus the client-only bits (favorite/audio/report
 *  buttons) that need JS/auth anyway.
 *
 *  `term` is the looked-up term the page lives at (`/word/<term>`), i.e. the
 *  cache key. It decides the canonical URL; `entry.word` is only display text.
 *  The two differ in case at most for LLM entries, and can differ entirely
 *  for dictionary-tier ones. */
export function renderWordPage(entry: DictionaryEntry, publicBaseUrl: string, term: string = entry.word): RenderedPage {
  const canonical = `${publicBaseUrl}/word/${encodeURIComponent(term)}`
  const description = buildWordDescription(pickFirstDefinition(entry), entry.word)
  const phoneticText = entry.phonetics.find((p) => p.text)?.text

  const meaningsHtml = entry.meanings
    .map(
      (m) => `
      <section class="pos-section">
        <h3 class="pos-label">${escapeHtml(m.partOfSpeech)}</h3>
        <ol class="defs">
          ${m.definitions
            .map(
              (d) => `
          <li class="def-item">
            <div class="def-head">
              <p class="def-text">${escapeHtml(d.definition)}</p>
              ${d.cefr ? `<span class="cefr-badge" data-level="${d.cefr}">${d.cefr}</span>` : ''}
            </div>
            ${
              d.grammar || d.register
                ? `<p class="def-labels">${d.grammar ? `<span class="def-label">${escapeHtml(d.grammar)}</span>` : ''}${d.register ? `<span class="def-label">${escapeHtml(d.register)}</span>` : ''}</p>`
                : ''
            }
            ${
              d.examples && d.examples.length > 0
                ? `<ul class="def-examples">${d.examples
                    .map(
                      (ex) =>
                        `<li class="def-example">&quot;${escapeHtml(ex.text)}&quot;${ex.cefr ? `<span class="cefr-badge cefr-badge-sm" data-level="${ex.cefr}">${ex.cefr}</span>` : ''}</li>`
                    )
                    .join('')}</ul>`
                : ''
            }
          </li>`
            )
            .join('')}
        </ol>
      </section>`
    )
    .join('')

  const commonMistakesHtml =
    entry.commonMistakes && entry.commonMistakes.length > 0
      ? `
      <section class="common-mistakes">
        <h3 class="common-mistakes-label">Common mistakes</h3>
        <ul class="common-mistakes-list">
          ${entry.commonMistakes
            .map(
              (m) =>
                `<li><span class="mistake-wrong">${escapeHtml(m.wrong)}</span><span class="mistake-arrow">→</span><span class="mistake-right">${escapeHtml(m.right)}</span>${m.note ? `<p class="mistake-note">${escapeHtml(m.note)}</p>` : ''}</li>`
            )
            .join('')}
        </ul>
      </section>`
      : ''

  const collocationsHtml =
    entry.collocations && entry.collocations.length > 0
      ? `<section class="chips-section"><h3 class="chips-label">Collocations</h3>${renderChips(entry.collocations)}</section>`
      : ''

  const wordFamilyHtml =
    entry.wordFamily && entry.wordFamily.length > 0
      ? `<section class="chips-section"><h3 class="chips-label">Word family</h3>${renderChips(entry.wordFamily)}</section>`
      : ''

  const bodyHtml = `
    <article class="word-entry">
      <header class="word-header">
        <div>
          <h1 class="headword">${escapeHtml(entry.word)}</h1>
          ${phoneticText ? `<p class="phonetic">${escapeHtml(phoneticText)}</p>` : ''}
          ${entry.translation ? `<p class="translation">${escapeHtml(entry.translation)}</p>` : ''}
        </div>
      </header>
      <div class="meanings">${meaningsHtml}</div>
      ${commonMistakesHtml}
      ${collocationsHtml}
      ${wordFamilyHtml}
    </article>`

  return {
    title: buildWordTitle(entry.word),
    description,
    canonical,
    bodyHtml,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'DefinedTerm',
      name: entry.word,
      description,
      url: canonical,
    },
  }
}

export interface BrowsePageInput {
  letter: string
  letters: string[]
  words: string[]
  page: number
  totalPages: number
  publicBaseUrl: string
}

function letterPageHref(letter: string, page: number): string {
  return page <= 1 ? `/browse/${letter}` : `/browse/${letter}/${page}`
}

/** Alphabetical index page: a link graph for crawlers + a browse path for
 *  users (to-do §5 "Alphabetical browse/index pages"). */
export function renderBrowsePage(input: BrowsePageInput): RenderedPage {
  const { letter, letters, words, page, totalPages, publicBaseUrl } = input
  const canonical = `${publicBaseUrl}${letterPageHref(letter, page)}`
  const title = `Browse words starting with "${letter}"${totalPages > 1 ? ` (page ${page} of ${totalPages})` : ''} — Open Dictionary`
  const description = `Alphabetical list of ${words.length} word${words.length === 1 ? '' : 's'} starting with "${letter}" on Open Dictionary.`

  const letterNav = letters
    .map((l) => `<a href="${escapeHtml(`/browse/${l}`)}">${escapeHtml(l.toUpperCase())}</a>`)
    .join(' ')

  const wordList = words
    .map((w) => `<li><a href="${escapeHtml(`/word/${encodeURIComponent(w)}`)}">${escapeHtml(w)}</a></li>`)
    .join('')

  const pagination = `
    ${page > 1 ? `<a href="${escapeHtml(letterPageHref(letter, page - 1))}">&laquo; Previous</a>` : ''}
    ${page < totalPages ? `<a href="${escapeHtml(letterPageHref(letter, page + 1))}">Next &raquo;</a>` : ''}`

  const bodyHtml = `
    <div class="browse-page">
      <h1 class="page-title">Browse: ${escapeHtml(letter.toUpperCase())}</h1>
      <nav class="browse-letters">${letterNav}</nav>
      <ul class="browse-word-list">${wordList}</ul>
      <nav class="browse-pagination">${pagination}</nav>
    </div>`

  return { title, description, canonical, bodyHtml }
}

/** Splices a rendered page's title/description/canonical/JSON-LD/body into
 *  the built dist/index.html so it ships with the exact same JS/CSS bundle
 *  references as the live SPA (no build coupling — this is the same file
 *  Vite just built). React uses createRoot (not hydrateRoot, see main.tsx),
 *  so the client bundle fully replaces this server-rendered content on
 *  mount rather than hydrating it — no mismatch risk. */
export function injectPage(template: string, page: RenderedPage): string {
  let html = template

  html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(page.title)}</title>`)
  html = html.replace(
    /<meta name="description" content="[^"]*"\s*\/?>/,
    `<meta name="description" content="${escapeHtml(page.description)}" />`
  )
  html = html.replace(
    /<meta property="og:title" content="[^"]*"\s*\/?>/,
    `<meta property="og:title" content="${escapeHtml(page.title)}" />`
  )
  html = html.replace(
    /<meta property="og:description" content="[^"]*"\s*\/?>/,
    `<meta property="og:description" content="${escapeHtml(page.description)}" />`
  )

  const headExtras: string[] = [`<link rel="canonical" href="${escapeHtml(page.canonical)}" />`]
  if (page.noindex) headExtras.push('<meta name="robots" content="noindex" />')
  if (page.jsonLd) {
    const json = JSON.stringify(page.jsonLd).replace(/</g, '\\u003c')
    headExtras.push(`<script type="application/ld+json">${json}</script>`)
  }
  html = html.replace('</head>', `${headExtras.join('\n    ')}\n  </head>`)

  html = html.replace('<div id="root"></div>', `<div id="root">${page.bodyHtml}</div>`)

  return html
}

export function buildSitemapXml(urls: { loc: string; lastmod?: string }[]): string {
  const entries = urls
    .map(
      (u) =>
        `  <url>\n    <loc>${escapeHtml(u.loc)}</loc>${u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : ''}\n  </url>`
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`
}
