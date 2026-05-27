import { useEffect, useState } from 'react'
import { lookupWord } from '../api/dictionary.js'

export function useDictionary(word) {
  const [state, setState] = useState({
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

    lookupWord(word)
      .then((data) => {
        if (cancelled) return
        setState({ status: 'success', data, error: null })
      })
      .catch((error) => {
        if (cancelled) return
        setState({ status: 'error', data: null, error })
      })

    return () => {
      cancelled = true
    }
  }, [word])

  return state
}
