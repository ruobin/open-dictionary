import { useState } from 'react'
import { reportEntry } from '../api/report'
import { useI18n } from '../i18n/I18nContext'

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
  const { t } = useI18n()

  async function handleReport() {
    setState('sending')
    const ok = await reportEntry(word, sourceLang, targetLang)
    setState(ok ? 'sent' : 'error')
  }

  if (state === 'sent') {
    return <p className="report-status">{t('report.thanks')}</p>
  }

  return (
    <button
      type="button"
      className="report-btn"
      onClick={handleReport}
      disabled={state === 'sending'}
    >
      {state === 'sending'
        ? t('report.sending')
        : state === 'error'
          ? t('report.error')
          : t('report.cta')}
    </button>
  )
}
