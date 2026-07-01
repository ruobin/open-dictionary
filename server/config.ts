import 'dotenv/config'
import { config as loadEnvFile } from 'dotenv'

// Load server-only secrets from server/.env. Additive only —
// never overrides values already in the environment or the root .env.
loadEnvFile({ path: 'server/.env' })

/** Reads a required env var; exits with a clear message when missing. */
export function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error('Missing required env var in server/.env:', name)
    console.error(
      'Need: AUTH0_DOMAIN, AUTH0_AUDIENCE, AUTH0_MGMT_CLIENT_ID, AUTH0_MGMT_CLIENT_SECRET'
    )
    process.exit(1)
  }
  return value
}

export const AUTH0_DOMAIN = required('AUTH0_DOMAIN')
export const AUTH0_AUDIENCE = required('AUTH0_AUDIENCE')
export const AUTH0_MGMT_CLIENT_ID = required('AUTH0_MGMT_CLIENT_ID')
export const AUTH0_MGMT_CLIENT_SECRET = required('AUTH0_MGMT_CLIENT_SECRET')
export const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173'
export const TRUST_PROXY = process.env.TRUST_PROXY ?? '0'
export const NODE_ENV = process.env.NODE_ENV ?? 'development'
export const PORT = Number(process.env.PORT ?? 3001)
export const IS_PROD = NODE_ENV === 'production'
export const MONGODB_URI = process.env.MONGODB_URI?.trim()
export const MONGODB_DB = process.env.MONGODB_DB?.trim() || undefined
export const FREE_DICTIONARY_API_BASE = process.env.FREE_DICTIONARY_API_BASE?.trim() || undefined
export const DICTIONARY_API_BASE = process.env.DICTIONARY_API_BASE?.trim() || undefined
export const MERRIAM_WEBSTER_API_KEY = process.env.MERRIAM_WEBSTER_API_KEY?.trim() || undefined
export const TRANSLATE_RATE_LIMIT_RPM = parseInt(process.env.TRANSLATE_RATE_LIMIT_RPM ?? '20', 10) || 20
export const FAVORITES_RATE_LIMIT_RPM = parseInt(process.env.FAVORITES_RATE_LIMIT_RPM ?? '120', 10) || 120
export const USERDATA_RATE_LIMIT_RPM = parseInt(process.env.USERDATA_RATE_LIMIT_RPM ?? '60', 10) || 60
