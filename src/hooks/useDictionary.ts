import { useEffect, useState } from 'react'
import { shouldAnimate } from '../../shared/liveReveal'
import { lookupWordStream, type DictionaryEntry, type LookupError } from '../api/dictionary'

export type LookupStatus = 'idle' | 'loading' | 'success' | 'error'

export interface DictionaryState {
  status: LookupStatus
  /** Final entries once `status` is 'success'. While 'loading', holds the
   *  best-so-far partial entry when the server is streaming one (else null). */
  data: DictionaryEntry[] | null
  error: LookupError | null
  /** True when the answer was streamed in (or took long enough to feel like it),
   *  so the page should reveal its text progressively. Instant cache hits: false. */
  animate: boolean
}


export function useDictionary(
  word: string,
  sourceLang = 'en',
  targetLang = 'en'
): DictionaryState {
  const [state, setState] = useState<DictionaryState>({
    status: word ? 'loading' : 'idle',
    data: null,
    error: null,
    animate: false,
  })

  useEffect(() => {
    if (!word) {
      setState({ status: 'idle', data: null, error: null, animate: false })
      return
    }

    let cancelled = false
    const controller = new AbortController()
    setState({ status: 'loading', data: null, error: null, animate: false })
    const startedAt = Date.now()
    let sawPartial = false

    lookupWordStream(word, sourceLang, targetLang, {
      signal: controller.signal,
      onPartial: (partial) => {
        if (cancelled) return
        sawPartial = true
        setState((prev) =>
          prev.status === 'loading' ? { status: 'loading', data: partial, error: null, animate: true } : prev
        )
      },
    })
      .then((data) => {
        if (cancelled) return
        setState({ status: 'success', data, error: null, animate: shouldAnimate(sawPartial, Date.now() - startedAt) })
      })
      .catch((error: LookupError) => {
        if (cancelled) return
        setState({ status: 'error', data: null, error, animate: false })
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [word, sourceLang, targetLang])

  return state
}
