import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import WordEntry from './WordEntry'
import { I18nProvider } from '../i18n/I18nContext'
import { dictionaries, LOCALES } from '../i18n/translations'
import type { DictionaryEntry } from '../api/dictionary'

const MW = { name: 'Merriam-Webster', url: 'https://www.merriam-webster.com/' }
const DICT_ENTRY: DictionaryEntry = {
  word: 'cull',
  phonetics: [],
  meanings: [{ partOfSpeech: 'verb', definitions: [{ definition: 'to select from a group' }] }],
  dictionarySource: MW,
}

const render = (entry: DictionaryEntry, sourceLang: string, targetLang: string): string =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        I18nProvider,
        null,
        createElement(WordEntry, { entry, sourceLang, targetLang, isFavorite: false, onToggleFavorite: () => {} })
      )
    )
  )

describe('WordEntry dictionary attribution', () => {
  it('links Merriam-Webster and flags English-only for en→zh fallback', () => {
    const html = render(DICT_ENTRY, 'en', 'zh')
    expect(html).toContain('word-dictionary-source')
    expect(html).toContain('href="https://www.merriam-webster.com/"')
    expect(html).toContain('>Merriam-Webster</a>')
    expect(html).toContain('word-dictionary-english-only')
    expect(html).not.toContain('word-generated-by')
  })

  it('does not claim English-only for same-language lookups', () => {
    expect(render(DICT_ENTRY, 'en', 'en')).not.toContain('word-dictionary-english-only')
  })

  it('shows no attribution for LLM entries, which keep the generatedBy footnote', () => {
    const html = render({ ...DICT_ENTRY, dictionarySource: undefined, generatedBy: { models: ['m1'] } }, 'en', 'zh')
    expect(html).not.toContain('word-dictionary-source')
    expect(html).toContain('word-generated-by')
  })

  it('has attribution strings in every locale', () => {
    for (const locale of LOCALES) {
      const d = dictionaries[locale] as Record<string, string>
      expect(d['word.dictionarySource']).toContain('{source}')
      expect(d['word.dictionaryEnglishOnly']).toBeTruthy()
    }
  })
})
