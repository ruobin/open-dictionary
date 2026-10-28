import { describe, expect, it } from 'vitest'
import { readSse, type SseMessage } from './sse'

function streamOf(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === 'string' ? encoder.encode(c) : c)
      controller.close()
    },
  })
}

async function collect(chunks: Array<string | Uint8Array>): Promise<SseMessage[]> {
  const out: SseMessage[] = []
  await readSse(streamOf(chunks), (m) => out.push(m))
  return out
}

describe('readSse', () => {
  it('parses data-only and named events', async () => {
    expect(await collect(['data: {"a":1}\n\nevent: ping\ndata: x\n\n'])).toEqual([
      { data: '{"a":1}' },
      { event: 'ping', data: 'x' },
    ])
  })

  it('reassembles events split across arbitrary chunk boundaries', async () => {
    const text = 'data: {"hello":"wor'
    expect(await collect([text, 'ld"}\n', '\ndata: [DONE]\n\n'])).toEqual([
      { data: '{"hello":"world"}' },
      { data: '[DONE]' },
    ])
  })

  it('handles CRLF, including a CRLF split between chunks', async () => {
    expect(await collect(['data: one\r', '\n\r\ndata: two\r\n\r\n'])).toEqual([{ data: 'one' }, { data: 'two' }])
  })

  it('joins multi-line data and ignores comments', async () => {
    expect(await collect([': keep-alive\ndata: a\ndata: b\n\n'])).toEqual([{ data: 'a\nb' }])
  })

  it('does not split a multi-byte UTF-8 character across chunks', async () => {
    const bytes = new TextEncoder().encode('data: 跑步\n\n')
    expect(await collect([bytes.slice(0, 8), bytes.slice(8)])).toEqual([{ data: '跑步' }])
  })

  it('flushes a final event that lacks the trailing blank line', async () => {
    expect(await collect(['data: tail'])).toEqual([{ data: 'tail' }])
  })
})
