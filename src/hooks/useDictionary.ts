import { useEffect, useState } from 'react'
import { lookupWord, type DictionaryEntry, type LookupError } from '../api/dictionary'

export type LookupStatus = 'idle' | 'loading' | 'success' | 'error'

export interface DictionaryState {
  status: LookupStatus
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
    setState({ status: 'loading', data: null, error: null })

    lookupWord(word, sourceLang, targetLang)
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
    }
  }, [word, sourceLang, targetLang])

  return state
}
