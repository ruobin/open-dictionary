import { MongoClient, type Db } from 'mongodb'

let client: MongoClient | null = null
let database: Db | null = null

const TRANSLATION_TTL_SECONDS = 365 * 24 * 60 * 60 // 1 year (design doc §6)
const MORE_EXAMPLES_TTL_SECONDS = 90 * 24 * 60 * 60 // 90 days — more speculative/long-tail than the main cache

/** Connects to MongoDB and ensures required indexes (idempotent). */
export async function connectMongo(uri: string, dbName = 'open-dictionary'): Promise<Db> {
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 })
  await client.connect()
  database = client.db(dbName)
  await ensureIndexes(database)
  return database
}

/** Returns the connected DB, or null if never connected / unavailable. */
export function getMongoDb(): Db | null {
  return database
}

async function ensureIndexes(db: Db): Promise<void> {
  // Dict cache: unique per (word, sourceLang, targetLang, version) + TTL on fetchedAt.
  // `version` was added to the key (to-do §2) so prompt/schema bumps get a fresh
  // cache slot instead of serving a frozen pre-bump entry for the full TTL.
  const translations = db.collection('translations')
  try {
    await translations.dropIndex('translations_key')
  } catch (err) {
    if ((err as { codeName?: string })?.codeName !== 'IndexNotFound') throw err
  }
  await translations.createIndex(
    { word: 1, sourceLang: 1, targetLang: 1, version: 1 },
    { unique: true, name: 'translations_key_v2' }
  )
  await translations.createIndex(
    { fetchedAt: 1 },
    { expireAfterSeconds: TRANSLATION_TTL_SECONDS, name: 'translations_ttl' }
  )
  // Autocomplete (to-do §6): prefix scan over cached words for a given source
  // language, e.g. { sourceLang: 'en', word: /^ser/ }.
  await translations.createIndex(
    { sourceLang: 1, word: 1 },
    { name: 'translations_suggest' }
  )

  // Favorites: one per (userKey, word, sourceLang, targetLang); list by userKey.
  const favorites = db.collection('favorites')
  await favorites.createIndex(
    { userKey: 1, word: 1, sourceLang: 1, targetLang: 1 },
    { unique: true, name: 'favorites_key' }
  )
  await favorites.createIndex({ userKey: 1 }, { name: 'favorites_user' })

  // Reports ("Report this entry", to-do §4): reviewed by word, newest first.
  const reports = db.collection('reports')
  await reports.createIndex(
    { word: 1, sourceLang: 1, targetLang: 1 },
    { name: 'reports_word' }
  )
  await reports.createIndex({ createdAt: -1 }, { name: 'reports_recent' })

  // "More examples like this" (to-do §3): _id is already the cache-key hash
  // (word + sense + constraints), so only a TTL index is needed.
  const moreExamples = db.collection('more_examples')
  await moreExamples.createIndex(
    { fetchedAt: 1 },
    { expireAfterSeconds: MORE_EXAMPLES_TTL_SECONDS, name: 'more_examples_ttl' }
  )
}
