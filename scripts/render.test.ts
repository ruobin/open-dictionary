import { describe, expect, it } from 'vitest'
import {
  bucketLetter,
  buildSitemapXml,
  escapeHtml,
  injectPage,
  paginate,
  renderBrowsePage,
  renderWordPage,
} from './render'
import type { DictionaryEntry } from '../server/translate'

describe('escapeHtml', () => {
  it('escapes the five HTML-sensitive characters', () => {
    expect(escapeHtml(`<script>&"'</script>`)).toBe(
      '&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;'
    )
  })

  it('leaves plain text unchanged', () => {
    expect(escapeHtml('serendipity')).toBe('serendipity')
  })
})

describe('bucketLetter', () => {
  it('buckets by lowercase first letter', () => {
    expect(bucketLetter('Hello')).toBe('h')
    expect(bucketLetter('zebra')).toBe('z')
  })

  it('buckets non-alphabetic first characters as "other"', () => {
    expect(bucketLetter('中文')).toBe('other')
    expect(bucketLetter('123abc')).toBe('other')
  })
})

describe('paginate', () => {
  it('chunks items into fixed-size pages', () => {
    expect(paginate([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it('returns a single empty page for an empty list', () => {
    expect(paginate([], 200)).toEqual([[]])
  })

  it('returns a single page when everything fits', () => {
    expect(paginate([1, 2], 200)).toEqual([[1, 2]])
  })
})

function makeEntry(overrides: Partial<DictionaryEntry> = {}): DictionaryEntry {
  return {
    word: 'hello',
    phonetics: [{ text: '/həˈloʊ/' }],
    meanings: [
      {
        partOfSpeech: 'interjection',
        definitions: [{ definition: 'A greeting', examples: [{ text: 'Hello there!', cefr: 'A1' }] }],
      },
    ],
    ...overrides,
  }
}

describe('renderWordPage', () => {
  it('builds title, description, canonical, and JSON-LD from the entry', () => {
    const page = renderWordPage(makeEntry(), 'https://example.com')
    expect(page.title).toBe('HELLO | definition, examples, pronunciation — Open Dictionary')
    expect(page.description).toBe('A greeting')
    expect(page.canonical).toBe('https://example.com/word/hello')
    expect(page.jsonLd).toMatchObject({
      '@type': 'DefinedTerm',
      name: 'hello',
      url: 'https://example.com/word/hello',
    })
  })

  it('escapes user/LLM-produced text in the body HTML', () => {
    const page = renderWordPage(
      makeEntry({
        meanings: [
          {
            partOfSpeech: 'noun',
            definitions: [{ definition: '<script>alert(1)</script>' }],
          },
        ],
      }),
      'https://example.com'
    )
    expect(page.bodyHtml).not.toContain('<script>alert(1)</script>')
    expect(page.bodyHtml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('renders graded examples with their CEFR badge', () => {
    const page = renderWordPage(makeEntry(), 'https://example.com')
    expect(page.bodyHtml).toContain('Hello there!')
    expect(page.bodyHtml).toContain('data-level="A1"')
  })

  it('renders common mistakes, collocations, and word family only when present', () => {
    const withExtras = renderWordPage(
      makeEntry({
        commonMistakes: [{ wrong: 'make a photo', right: 'take a photo' }],
        collocations: ['heavy rain'],
        wordFamily: ['runner'],
      }),
      'https://example.com'
    )
    expect(withExtras.bodyHtml).toContain('Common mistakes')
    expect(withExtras.bodyHtml).toContain('make a photo')
    expect(withExtras.bodyHtml).toContain('Collocations')
    expect(withExtras.bodyHtml).toContain('href="/word/heavy%20rain"')
    expect(withExtras.bodyHtml).toContain('Word family')
    expect(withExtras.bodyHtml).toContain('href="/word/runner"')

    const without = renderWordPage(makeEntry(), 'https://example.com')
    expect(without.bodyHtml).not.toContain('Common mistakes')
    expect(without.bodyHtml).not.toContain('Collocations')
    expect(without.bodyHtml).not.toContain('Word family')
  })

  it('percent-encodes the word in the canonical URL', () => {
    const page = renderWordPage(makeEntry({ word: 'café au lait' }), 'https://example.com')
    expect(page.canonical).toBe('https://example.com/word/caf%C3%A9%20au%20lait')
  })
})

describe('renderBrowsePage', () => {
  it('lists words and links to their word pages', () => {
    const page = renderBrowsePage({
      letter: 'h',
      letters: ['a', 'h', 'z'],
      words: ['hello', 'happy'],
      page: 1,
      totalPages: 1,
      publicBaseUrl: 'https://example.com',
    })
    expect(page.canonical).toBe('https://example.com/browse/h')
    expect(page.bodyHtml).toContain('href="/word/hello"')
    expect(page.bodyHtml).toContain('href="/word/happy"')
    expect(page.bodyHtml).not.toContain('Previous')
    expect(page.bodyHtml).not.toContain('Next')
  })

  it('adds prev/next pagination links when there are multiple pages', () => {
    const page = renderBrowsePage({
      letter: 'h',
      letters: ['h'],
      words: ['hello'],
      page: 2,
      totalPages: 3,
      publicBaseUrl: 'https://example.com',
    })
    expect(page.canonical).toBe('https://example.com/browse/h/2')
    expect(page.bodyHtml).toContain('href="/browse/h"')
    expect(page.bodyHtml).toContain('href="/browse/h/3"')
  })
})

describe('injectPage', () => {
  const template = `<!doctype html>
<html>
  <head>
    <meta name="description" content="old description" />
    <meta property="og:title" content="old og title" />
    <meta property="og:description" content="old og description" />
    <title>old title</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`

  it('replaces title, description, og tags, and injects the body', () => {
    const html = injectPage(template, {
      title: 'New Title',
      description: 'New description',
      canonical: 'https://example.com/word/hello',
      bodyHtml: '<p>content</p>',
    })
    expect(html).toContain('<title>New Title</title>')
    expect(html).toContain('<meta name="description" content="New description" />')
    expect(html).toContain('<meta property="og:title" content="New Title" />')
    expect(html).toContain('<meta property="og:description" content="New description" />')
    expect(html).toContain('<div id="root"><p>content</p></div>')
    expect(html).not.toContain('old title')
  })

  it('adds a canonical link and JSON-LD script before </head>', () => {
    const html = injectPage(template, {
      title: 't',
      description: 'd',
      canonical: 'https://example.com/word/hello',
      bodyHtml: '',
      jsonLd: { '@type': 'DefinedTerm', name: 'hello' },
    })
    expect(html).toContain('<link rel="canonical" href="https://example.com/word/hello" />')
    expect(html).toContain('<script type="application/ld+json">')
    expect(html).toContain('"name":"hello"')
  })

  it('adds a noindex meta tag when requested', () => {
    const html = injectPage(template, {
      title: 't',
      description: 'd',
      canonical: 'https://example.com/x',
      bodyHtml: '',
      noindex: true,
    })
    expect(html).toContain('<meta name="robots" content="noindex" />')
  })

  it('escapes </script> so JSON-LD cannot break out of its script tag', () => {
    const html = injectPage(template, {
      title: 't',
      description: 'd',
      canonical: 'https://example.com/x',
      bodyHtml: '',
      jsonLd: { name: '</script><script>alert(1)</script>' },
    })
    expect(html).not.toContain('</script><script>alert(1)</script>')
    expect(html).toContain('\\u003c/script>\\u003cscript>alert(1)\\u003c/script>')
  })
})

describe('buildSitemapXml', () => {
  it('builds a valid sitemap with optional lastmod', () => {
    const xml = buildSitemapXml([
      { loc: 'https://example.com/', lastmod: '2026-07-11' },
      { loc: 'https://example.com/about' },
    ])
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain('<loc>https://example.com/</loc>')
    expect(xml).toContain('<lastmod>2026-07-11</lastmod>')
    expect(xml).toContain('<loc>https://example.com/about</loc>')
  })
})
