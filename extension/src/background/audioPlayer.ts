import type { AudioResponse, OffscreenPlayAudioMessage } from '../shared/messages'

/**
 * Pronunciation playback for the in-page result card.
 *
 * The card lives inside the host page, so an `<audio>` element there is
 * subject to the PAGE's Content-Security-Policy `media-src` — strict pages
 * (e.g. job boards, banks) block `media.merriam-webster.com` and the clip
 * silently never plays. Instead the card asks the worker to play it, and the
 * worker plays it in an offscreen document (an extension page, governed only
 * by the extension's own CSP). See RELEASE.md / README "Audio playback".
 */

export const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen/offscreen.html'

/** Only plain https clips are played: the message comes from a content
 *  script, so never forward arbitrary schemes (file:, data:, javascript:…). */
export function isPlayableAudioUrl(src: unknown): src is string {
  if (typeof src !== 'string') return false
  try {
    return new URL(src).protocol === 'https:'
  } catch {
    return false
  }
}

// Shared across concurrent calls: `createDocument` rejects if a document
// already exists or is being created.
let creating: Promise<void> | null = null

async function ensureOffscreenDocument(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
  })
  if (existing.length > 0) return

  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: ['AUDIO_PLAYBACK' as chrome.offscreen.Reason],
        justification: 'Play word pronunciation clips outside the host page, whose CSP can block media.',
      })
      .finally(() => {
        creating = null
      })
  }
  await creating
}

export async function playAudio(src: unknown): Promise<AudioResponse> {
  if (!isPlayableAudioUrl(src)) return { ok: false, error: 'audio_failed' }
  try {
    await ensureOffscreenDocument()
    const message: OffscreenPlayAudioMessage = { target: 'offscreen', type: 'OFFSCREEN_PLAY_AUDIO', src }
    const res = (await chrome.runtime.sendMessage(message)) as AudioResponse | undefined
    return res?.ok ? { ok: true } : { ok: false, error: 'audio_failed' }
  } catch (err) {
    console.warn('[open-dictionary] audio playback failed', { src, err })
    return { ok: false, error: 'audio_failed' }
  }
}
