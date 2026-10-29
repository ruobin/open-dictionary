import type { AudioResponse, OffscreenPlayAudioMessage } from '../shared/messages'

/**
 * Offscreen document: plays pronunciation clips on behalf of the in-page
 * result card (see background/audioPlayer.ts). It is an extension page, so
 * the host page's CSP does not apply to the `<audio>` loaded here.
 */

let current: HTMLAudioElement | null = null

async function play(src: string): Promise<AudioResponse> {
  // One clip at a time: a new click replaces whatever is still playing.
  current?.pause()
  const audio = new Audio(src)
  current = audio
  try {
    await audio.play()
    return { ok: true }
  } catch (err) {
    // AbortError = superseded by a newer click; not a failure worth surfacing.
    if (err instanceof DOMException && err.name === 'AbortError') return { ok: true }
    console.warn('[open-dictionary] offscreen audio failed', { src, err, mediaError: audio.error?.message })
    return { ok: false, error: 'audio_failed' }
  }
}

chrome.runtime.onMessage.addListener((message: Partial<OffscreenPlayAudioMessage>, _sender, sendResponse) => {
  if (message?.target !== 'offscreen' || message.type !== 'OFFSCREEN_PLAY_AUDIO' || typeof message.src !== 'string') {
    return false // not for us; let other listeners answer
  }
  void play(message.src).then(sendResponse)
  return true // async response
})
