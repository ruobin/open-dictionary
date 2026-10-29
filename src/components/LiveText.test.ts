import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LiveProvider, LiveText, StreamCaret } from './LiveText'

const render = (animate: boolean, streaming: boolean, text: string): string =>
  renderToStaticMarkup(createElement(LiveProvider, { value: { animate, streaming }, children: createElement(LiveText, { text }) }))

describe('LiveText', () => {
  it('renders the full text immediately when the lookup is not animated (cache hits)', () => {
    expect(render(false, false, 'to move quickly')).toBe('to move quickly')
  })

  it('starts empty when animated, then reveals over time', () => {
    expect(render(true, true, 'to move quickly')).toBe('')
  })

  it('shows the caret only while streaming', () => {
    const caret = (streaming: boolean): string =>
      renderToStaticMarkup(
        createElement(LiveProvider, { value: { animate: true, streaming }, children: createElement(StreamCaret) })
      )
    expect(caret(true)).toContain('stream-caret')
    expect(caret(false)).toBe('')
  })
})
