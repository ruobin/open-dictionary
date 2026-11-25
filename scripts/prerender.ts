/**
 * Batch SEO prerender (to-do §5, "cheapest v1"): generates static HTML for
 * every already-cached en→en word entry plus alphabetical browse pages and a
 * sitemap, all written into the already-built `dist/` directory.
 *
 * Deliberately NOT a live per-request render: only words that are already in
 * the Mongo cache get a page, so crawler traffic can never trigger a new LLM
 * call. Run this after `npm run build` and before shipping `dist/` — it
 * needs MONGODB_URI reachable, which the CI build step does not have, so it
 * is a separate opt-in script rather than part of `npm run build`.
 *
 * The written files rely on the SPA-fallback nginx rule already required for
 * this app to work at all (`try_files $uri $uri/ /index.html;`): a request
 * for /word/hello resolves to dist/word/hello/index.html because nginx tries
 * "$uri/" (a directory with an index file) before falling back to the SPA
 * shell. No nginx config changes are needed as long as that rule is in place
 * — the same rule that makes hard-refreshing /word/:term work today.
 *
 * Usage: npm run prerender
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MONGODB_DB, MONGODB_URI, PUBLIC_BASE_URL } from '../server/config'
import { connectMongo } from '../server/db'
import { CACHE_VERSION } from '../server/translate'
import type { TranslationDoc } from '../server/cache/translationCache'
import {
  WORDS_PER_BROWSE_PAGE,
  bucketLetter,
  buildSitemapXml,
  injectPage,
  paginate,
  renderBrowsePage,
  renderWordPage,
  wordPageFor,
} from './render'

const DIST_DIR = join(process.cwd(), 'dist')

/** Tolerated word-page failures before the run aborts: this many, or this share of the pages written. */
const MAX_FAILED_PAGES = 5
const MAX_FAILED_SHARE = 0.01

interface SitemapUrl {
  loc: string
  lastmod?: string
}

function writeHtmlFile(relDir: string, html: string): void {
  const dir = join(DIST_DIR, relDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), html, 'utf8')
}

async function main(): Promise<void> {
  if (!existsSync(DIST_DIR)) {
    console.error(`[prerender] ${DIST_DIR} does not exist — run "npm run build" first.`)
    process.exit(1)
  }
  const template = readFileSync(join(DIST_DIR, 'index.html'), 'utf8')

  if (!MONGODB_URI) {
    console.error('[prerender] MONGODB_URI is not set — cannot read the translation cache.')
    process.exit(1)
  }
  const db = await connectMongo(MONGODB_URI, MONGODB_DB)
  const collection = db.collection<TranslationDoc>('translations')

  // en→en only (to-do §5 canonical-URL decision): translation-pair variants
  // aren't separately indexed yet, so only the canonical page is prerendered.
  const docs = await collection
    .find({ sourceLang: 'en', targetLang: 'en', source: { $in: ['llm', 'dict'] }, version: CACHE_VERSION })
    .toArray()

  const sitemapUrls: SitemapUrl[] = [
    { loc: `${PUBLIC_BASE_URL}/` },
    { loc: `${PUBLIC_BASE_URL}/about` },
  ]

  let wordPageCount = 0
  let skippedUnlisted = 0
  const failed: string[] = []
  const wordsByLetter = new Map<string, string[]>()

  for (const doc of docs) {
    // Path, URL and listing come from the cache key, not the entry's headword
    // (see wordPageFor).
    const target = wordPageFor(doc)
    if (!target) continue
    if (target === 'unlisted') {
      skippedUnlisted += 1
      continue
    }
    const { term, entry } = target

    try {
      const page = renderWordPage(entry, PUBLIC_BASE_URL, term)
      writeHtmlFile(`word/${term}`, injectPage(template, page))
      sitemapUrls.push({ loc: page.canonical, lastmod: doc.fetchedAt.toISOString().slice(0, 10) })
    } catch (err) {
      // One odd entry must not abort the run (and with it the deploy).
      failed.push(doc._id)
      console.warn(`[prerender] skipped entry ${doc._id}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    wordPageCount += 1

    const letter = bucketLetter(term)
    const list = wordsByLetter.get(letter) ?? []
    list.push(term)
    wordsByLetter.set(letter, list)
  }

  // A few bad entries are skipped; many failures mean something systemic (a
  // full disk, a broken template). Stop before the deploy script's
  // `rsync --delete` publishes a site with most of its pages missing.
  if (failed.length > Math.max(MAX_FAILED_PAGES, wordPageCount * MAX_FAILED_SHARE)) {
    console.error(`[prerender] ${failed.length} word page(s) failed to render — aborting.`)
    process.exit(1)
  }

  const letters = [...wordsByLetter.keys()].sort()
  let browsePageCount = 0
  for (const letter of letters) {
    const words = (wordsByLetter.get(letter) ?? []).sort((a, b) => a.localeCompare(b))
    const pages = paginate(words, WORDS_PER_BROWSE_PAGE)
    for (let i = 0; i < pages.length; i++) {
      const pageNum = i + 1
      const rendered = renderBrowsePage({
        letter,
        letters,
        words: pages[i],
        page: pageNum,
        totalPages: pages.length,
        publicBaseUrl: PUBLIC_BASE_URL,
      })
      const relDir = pageNum === 1 ? `browse/${letter}` : `browse/${letter}/${pageNum}`
      writeHtmlFile(relDir, injectPage(template, rendered))
      sitemapUrls.push({ loc: rendered.canonical })
      browsePageCount += 1
    }
  }

  writeFileSync(join(DIST_DIR, 'sitemap.xml'), buildSitemapXml(sitemapUrls), 'utf8')

  const robotsPath = join(DIST_DIR, 'robots.txt')
  const robots = existsSync(robotsPath) ? readFileSync(robotsPath, 'utf8').trimEnd() : 'User-agent: *\nAllow: /'
  writeFileSync(robotsPath, `${robots}\nSitemap: ${PUBLIC_BASE_URL}/sitemap.xml\n`, 'utf8')

  console.log(
    `[prerender] wrote ${wordPageCount} word page(s), ${browsePageCount} browse page(s), sitemap.xml (${sitemapUrls.length} URLs), and updated robots.txt` +
      (skippedUnlisted > 0
        ? `; skipped ${skippedUnlisted} entr${skippedUnlisted === 1 ? 'y' : 'ies'} whose term is not listed publicly`
        : '') +
      (failed.length > 0 ? `; ${failed.length} failed (see warnings above)` : '')
  )
  process.exit(0)
}

void main()
