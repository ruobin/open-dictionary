import type { DictionaryEntry } from '../server/translate'
import { buildWordDescription, buildWordTitle } from '../shared/seo'
import { wordHref } from '../shared/wordLink'

/**
 * Pure HTML-building helpers for scripts/prerender.ts. Kept dependency-free
 * (no Mongo/fs) so they're unit-testable like the rest of this codebase's
 * pure functions.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export const WORDS_PER_BROWSE_PAGE = 200

/** First-letter bucket for the alphabetical browse pages: 'a'-'z', or
 *  'other' for anything not starting with a plain ASCII letter. */
export function bucketLetter(word: string): string {
  const c = word.trim().toLowerCase().charAt(0)
  return /[a-z]/.test(c) ? c : 'other'
}

/** Splits a sorted list into fixed-size pages (page 1 first). */
export function paginate<T>(items: T[], pageSize: number): T[][] {
  if (items.length === 0) return [[]]
  const pages: T[][] = []
  for (let i = 0; i < items.length; i += pageSize) {
    pages.push(items.slice(i, i + pageSize))
  }
  return pages
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

function renderChips(items: string[] | undefined): string {
  if (!items || items.length === 0) return ''
  return `<div class="chips">${items
    .map((item) => `<a class="chip" href="${escapeHtml(wordHref(item))}">${escapeHtml(item)}</a>`)
    .join('')}</div>`
}

/** Server-rendered content mirroring src/components/WordEntry.tsx +
 *  PosSection.tsx, minus the client-only bits (favorite/audio/report
 *  buttons) that need JS/auth anyway. */
export function renderWordPage(entry: DictionaryEntry, publicBaseUrl: string): RenderedPage {
  const canonical = `${publicBaseUrl}/word/${encodeURIComponent(entry.word)}`
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
