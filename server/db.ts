import { MongoClient, type Db } from 'mongodb'

let client: MongoClient | null = null
let database: Db | null = null

const TRANSLATION_TTL_SECONDS = 365 * 24 * 60 * 60 // 1 year (design doc §6)

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
  // Dict cache: unique per (word, sourceLang, targetLang) + TTL on fetchedAt.
  const translations = db.collection('translations')
  await translations.createIndex(
    { word: 1, sourceLang: 1, targetLang: 1 },
    { unique: true, name: 'translations_key' }
  )
  await translations.createIndex(
    { fetchedAt: 1 },
    { expireAfterSeconds: TRANSLATION_TTL_SECONDS, name: 'translations_ttl' }
  )

  // Favorites: one per (userKey, word, sourceLang, targetLang); list by userKey.
  const favorites = db.collection('favorites')
  await favorites.createIndex(
    { userKey: 1, word: 1, sourceLang: 1, targetLang: 1 },
    { unique: true, name: 'favorites_key' }
  )
  await favorites.createIndex({ userKey: 1 }, { name: 'favorites_user' })
}
