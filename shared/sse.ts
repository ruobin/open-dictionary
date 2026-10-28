/**
 * Minimal Server-Sent-Events reader for upstream LLM streams (`stream: true`
 * on Chat Completions / Responses). Handles chunk boundaries that split lines
 * or UTF-8 sequences, `\r\n` line endings, comments, and multi-line `data:`.
 */
export interface SseMessage {
  event?: string
  data: string
}

export async function readSse(
  body: ReadableStream<Uint8Array>,
  onMessage: (msg: SseMessage) => void
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event: string | undefined
  let data: string[] = []

  const flush = (): void => {
    if (data.length > 0) onMessage({ ...(event ? { event } : {}), data: data.join('\n') })
    event = undefined
    data = []
  }

  const handleLine = (line: string): void => {
    if (line === '') return flush()
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') data.push(value)
    else if (field === 'event') event = value
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.search(/\r\n|\n|\r/)) !== -1) {
        // A lone trailing "\r" may be the first half of "\r\n" split across chunks.
        if (buffer[nl] === '\r' && nl === buffer.length - 1) break
        const line = buffer.slice(0, nl)
        const sepLen = buffer.startsWith('\r\n', nl) ? 2 : 1
        buffer = buffer.slice(nl + sepLen)
        handleLine(line)
      }
    }
    buffer += decoder.decode()
    if (buffer.endsWith('\r')) buffer = buffer.slice(0, -1)
    if (buffer) handleLine(buffer)
    flush()
  } finally {
    reader.releaseLock()
  }
}
