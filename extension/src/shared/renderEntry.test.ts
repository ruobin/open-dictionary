import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EntryView, isExtensionPage } from './renderEntry'
import { LiveProvider, LiveText, StreamCaret } from './LiveText'
import type { DictionaryEntry } from '../types'

const ENTRY: DictionaryEntry = {
  word: 'hello',
  translation: 'hola',
  meanings: [{ partOfSpeech: 'interjection', definitions: [{ definition: 'A greeting', cefr: 'A1' }] }],
}

const view = (live?: { animate: boolean; streaming: boolean }): string =>
  renderToStaticMarkup(createElement(EntryView, { entry: ENTRY, webAppUrl: 'https://x/word/hello', live }))

describe('EntryView streaming', () => {
  it('renders everything in full, with no caret, by default (static callers and cache hits)', () => {
    const html = view()
    expect(html).toContain('hola')
    expect(html).toContain('A greeting')
    expect(html).not.toContain('od-caret')
  })

  it('shows the caret while streaming, and keeps the page chrome in place', () => {
    const html = view({ animate: true, streaming: true })
    expect(html).toContain('od-caret')
    expect(html).toContain('See full entry')
    expect(html).toContain('hello') // headword is never animated
  })

  it('starts animated text empty (it is revealed over the following frames)', () => {
    const html = view({ animate: true, streaming: false })
    expect(html).not.toContain('A greeting')
    expect(html).not.toContain('hola')
    expect(html).toContain('od-cefr') // badges are not animated
    expect(html).not.toContain('od-caret')
  })

  it('renders the full text when the lookup finished without animating', () => {
    const html = view({ animate: false, streaming: false })
    expect(html).toContain('A greeting')
    expect(html).toContain('hola')
  })
})

describe('extension LiveText', () => {
  const render = (animate: boolean, text: string): string =>
    renderToStaticMarkup(createElement(LiveProvider, { value: { animate, streaming: false }, children: createElement(LiveText, { text }) }))

  it('is full when not animated and empty when animated', () => {
    expect(render(false, 'to move quickly')).toBe('to move quickly')
    expect(render(true, 'to move quickly')).toBe('')
  })

  it('caret renders only while streaming', () => {
    const caret = (streaming: boolean): string =>
      renderToStaticMarkup(createElement(LiveProvider, { value: { animate: true, streaming }, children: createElement(StreamCaret) }))
    expect(caret(true)).toContain('od-caret')
    expect(caret(false)).toBe('')
  })
})

describe('EntryView audio buttons', () => {
  const WITH_AUDIO: DictionaryEntry = {
    ...ENTRY,
    phonetics: [{ text: '/həˈloʊ/', audio: 'https://media.merriam-webster.com/audio/prons/en/us/mp3/h/hello001.mp3' }],
  }
  const html = (): string =>
    renderToStaticMarkup(createElement(EntryView, { entry: WITH_AUDIO, webAppUrl: 'https://x/word/hello' }))

  afterEach(() => vi.unstubAllGlobals())

  it('in the in-page card (host-page location) renders no <audio>: the worker plays the clip', () => {
    vi.stubGlobal('location', { protocol: 'https:' })
    expect(isExtensionPage()).toBe(false)
    const out = html()
    expect(out).toContain('od-audio-btn')
    expect(out).not.toContain('<audio')
  })

  it('on an extension page (popup) renders a local <audio>', () => {
    vi.stubGlobal('location', { protocol: 'chrome-extension:' })
    expect(isExtensionPage()).toBe(true)
    expect(html()).toContain('<audio')
  })
})
