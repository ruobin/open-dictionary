import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { dictionaries, LOCALES, type Locale, type TranslationKey } from './translations'

const STORAGE_KEY = 'locale'

function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as string[]).includes(v)
}

function detectInitial(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (isLocale(stored)) return stored
  } catch {
    // localStorage unavailable
  }
  // Fall back to the browser's language, if we support it.
  const nav = typeof navigator !== 'undefined' ? navigator.language : ''
  const head = nav.slice(0, 2).toLowerCase()
  if (isLocale(head)) return head
  return 'en'
}

type Params = Record<string, string | number>

interface I18nValue {
  locale: Locale
  setLocale: (l: Locale) => void
  t: (key: TranslationKey, params?: Params) => string
}

const I18nContext = createContext<I18nValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectInitial)

  useEffect(() => {
    document.documentElement.lang = locale
    try {
      localStorage.setItem(STORAGE_KEY, locale)
    } catch {
      // ignore write failure
    }
  }, [locale])

  const setLocale = useCallback((l: Locale) => setLocaleState(l), [])

  const t = useCallback(
    (key: TranslationKey, params?: Params) => {
      const dict = dictionaries[locale] ?? dictionaries.en
      let str: string = dict[key] ?? dictionaries.en[key] ?? key
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
        }
      }
      return str
    },
    [locale]
  )

  const value = useMemo<I18nValue>(() => ({ locale, setLocale, t }), [locale, setLocale, t])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within an I18nProvider')
  return ctx
}
