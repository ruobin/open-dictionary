import { useEffect, useState } from 'react'
import { lookupWordStream, type DictionaryEntry, type LookupError } from '../api/dictionary'

export type LookupStatus = 'idle' | 'loading' | 'success' | 'error'

export interface DictionaryState {
  status: LookupStatus
  /** Final entries once `status` is 'success'. While 'loading', holds the
   *  best-so-far partial entry when the server is streaming one (else null). */
  data: DictionaryEntry[] | null
  error: LookupError | null
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
  })

  useEffect(() => {
    if (!word) {
      setState({ status: 'idle', data: null, error: null })
      return
    }

    let cancelled = false
    const controller = new AbortController()
    setState({ status: 'loading', data: null, error: null })

    lookupWordStream(word, sourceLang, targetLang, {
      signal: controller.signal,
      onPartial: (partial) => {
        if (cancelled) return
        setState((prev) => (prev.status === 'loading' ? { status: 'loading', data: partial, error: null } : prev))
      },
    })
      .then((data) => {
        if (cancelled) return
        setState({ status: 'success', data, error: null })
      })
      .catch((error: LookupError) => {
        if (cancelled) return
        setState({ status: 'error', data: null, error })
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [word, sourceLang, targetLang])

  return state
}
