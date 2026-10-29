import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const CLIP = 'https://media.merriam-webster.com/audio/prons/en/us/mp3/m/method13.mp3'

function installFakeChrome(opts: { hasDocument: boolean; reply?: unknown; sendThrows?: boolean }) {
  const createDocument = vi.fn().mockResolvedValue(undefined)
  const sendMessage = vi.fn(async () => {
    if (opts.sendThrows) throw new Error('no receiver')
    return opts.reply
  })
  ;(globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      getURL: (p: string) => `chrome-extension://id/${p}`,
      getContexts: vi.fn().mockResolvedValue(opts.hasDocument ? [{}] : []),
      sendMessage,
    },
    offscreen: { createDocument },
  }
  return { createDocument, sendMessage }
}

describe('audioPlayer', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    delete (globalThis as { chrome?: unknown }).chrome
  })

  it('only accepts https URLs', async () => {
    const { isPlayableAudioUrl } = await import('./audioPlayer')
    expect(isPlayableAudioUrl(CLIP)).toBe(true)
    expect(isPlayableAudioUrl('http://x/a.mp3')).toBe(false)
    expect(isPlayableAudioUrl('data:audio/mp3;base64,AAAA')).toBe(false)
    expect(isPlayableAudioUrl('javascript:alert(1)')).toBe(false)
    expect(isPlayableAudioUrl('not a url')).toBe(false)
    expect(isPlayableAudioUrl(undefined)).toBe(false)
  })

  it('rejects a bad URL without touching chrome APIs', async () => {
    const { sendMessage, createDocument } = installFakeChrome({ hasDocument: false })
    const { playAudio } = await import('./audioPlayer')
    expect(await playAudio('file:///etc/passwd')).toEqual({ ok: false, error: 'audio_failed' })
    expect(createDocument).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('creates the offscreen document when missing, then forwards the clip to it', async () => {
    const { sendMessage, createDocument } = installFakeChrome({ hasDocument: false, reply: { ok: true } })
    const { playAudio } = await import('./audioPlayer')
    expect(await playAudio(CLIP)).toEqual({ ok: true })
    expect(createDocument).toHaveBeenCalledOnce()
    expect(createDocument.mock.calls[0][0]).toMatchObject({ reasons: ['AUDIO_PLAYBACK'] })
    expect(sendMessage).toHaveBeenCalledWith({ target: 'offscreen', type: 'OFFSCREEN_PLAY_AUDIO', src: CLIP })
  })

  it('reuses an existing offscreen document', async () => {
    const { createDocument } = installFakeChrome({ hasDocument: true, reply: { ok: true } })
    const { playAudio } = await import('./audioPlayer')
    await playAudio(CLIP)
    expect(createDocument).not.toHaveBeenCalled()
  })

  it('reports failure when the offscreen document fails or does not answer', async () => {
    installFakeChrome({ hasDocument: true, reply: { ok: false, error: 'audio_failed' } })
    let { playAudio } = await import('./audioPlayer')
    expect(await playAudio(CLIP)).toEqual({ ok: false, error: 'audio_failed' })

    vi.resetModules()
    installFakeChrome({ hasDocument: true, sendThrows: true })
    ;({ playAudio } = await import('./audioPlayer'))
    expect(await playAudio(CLIP)).toEqual({ ok: false, error: 'audio_failed' })
  })
})
