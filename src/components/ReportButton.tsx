import { useState } from 'react'
import { reportEntry } from '../api/report'

type ReportState = 'idle' | 'sending' | 'sent' | 'error'

export default function ReportButton({
  word,
  sourceLang,
  targetLang,
}: {
  word: string
  sourceLang: string
  targetLang: string
}) {
  const [state, setState] = useState<ReportState>('idle')

  async function handleReport() {
    setState('sending')
    const ok = await reportEntry(word, sourceLang, targetLang)
    setState(ok ? 'sent' : 'error')
  }

  if (state === 'sent') {
    return <p className="report-status">Thanks — we'll take a look.</p>
  }

  return (
    <button
      type="button"
      className="report-btn"
      onClick={handleReport}
      disabled={state === 'sending'}
    >
      {state === 'sending'
        ? 'Reporting…'
        : state === 'error'
          ? "Couldn't send — try again"
          : 'Report this entry'}
    </button>
  )
}
