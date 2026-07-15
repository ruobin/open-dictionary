import { useEffect, useState } from 'react'
import { useAdminOutletContext } from './AdminLayout'
import { listProviders, type ProviderView, type PlaygroundTargetResult } from '../../api/admin'
import { describeApiError } from '../../components/admin/adminErrors'
import { DEFAULT_SOURCE_LANG, DEFAULT_TARGET_LANG } from '../../../shared/languages'
import PlaygroundForm from '../../components/admin/PlaygroundForm'
import PlaygroundResults from '../../components/admin/PlaygroundResults'

export default function Playground() {
  const { auth } = useAdminOutletContext()
  const [providers, setProviders] = useState<ProviderView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<PlaygroundTargetResult[] | null>(null)
  const [sourceLang, setSourceLang] = useState(DEFAULT_SOURCE_LANG)
  const [targetLang, setTargetLang] = useState(DEFAULT_TARGET_LANG)
  const [resultLangs, setResultLangs] = useState({ sourceLang: DEFAULT_SOURCE_LANG, targetLang: DEFAULT_TARGET_LANG })

  useEffect(() => {
    listProviders(auth).then(setProviders).catch((err) => setError(describeApiError(err)))
  }, [auth])

  return (
    <div className="admin-page">
      <div className="admin-page-header">
        <h1>Playground</h1>
      </div>
      <p className="admin-hint">
        Look up a word with a direct LLM call — bypassing the translation cache — so you can compare raw
        provider/model output side by side before switching the active model.
      </p>
      {error && <div className="state-msg state-error">{error}</div>}

      <PlaygroundForm
        auth={auth}
        providers={providers}
        sourceLang={sourceLang}
        targetLang={targetLang}
        onLangsChange={(nextSource, nextTarget) => {
          setSourceLang(nextSource)
          setTargetLang(nextTarget)
        }}
        onResults={(res) => {
          setResults(res)
          setResultLangs({ sourceLang, targetLang })
        }}
      />

      {results && results.length > 0 && (
        <PlaygroundResults results={results} sourceLang={resultLangs.sourceLang} targetLang={resultLangs.targetLang} />
      )}
    </div>
  )
}
