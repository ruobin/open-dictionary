/**
 * One-time backfill: fills `translations.createdBy` for cache entries created
 * before 2026-10-30 (when live recording started) from `activity_log`.
 *
 * For each entry without `createdBy`, it uses the most recent activity record
 * with the same (word, sourceLang, targetLang) whose tier shows a real
 * generation (`llm` or `dictionary`) and is no later than the entry's
 * `fetchedAt` + 5 min. Writes through `fetchedAt` (late audio, fusion
 * upgrade) happen after generation, so that record is the lookup that created
 * the entry. Results are marked `inferred: true`. Entries with no matching
 * activity (older than the 180-day activity TTL, or created before activity
 * logging existed) are left alone.
 *
 * Dry run by default; pass `--apply` to write. Idempotent: only touches docs
 * that still lack `createdBy`. In production, run it inside the API container
 * (it needs the compose-network Mongo):
 *
 *   docker compose run --rm --no-deps -v "$PWD/scripts:/app/scripts" api \
 *     node --import tsx scripts/backfill-entry-creators.ts [--apply]
 */
import { MONGODB_DB, MONGODB_URI } from '../server/config'
import { connectMongo } from '../server/db'
import type { EntryCreator, TranslationDoc } from '../server/cache/translationCache'
import { CREATOR_IP_RETENTION_MS, type ActivityLogDoc } from '../server/activityLog'
import { normalizeIp } from '../server/abuseGuard'

const SLACK_MS = 5 * 60 * 1000

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  if (!MONGODB_URI) {
    console.error('[backfill] MONGODB_URI is not set.')
    process.exit(1)
  }
  const db = await connectMongo(MONGODB_URI, MONGODB_DB)
  const translations = db.collection<TranslationDoc>('translations')
  const activity = db.collection<ActivityLogDoc>('activity_log')

  const docs = await translations
    .find({ createdBy: { $exists: false } }, { projection: { word: 1, sourceLang: 1, targetLang: 1, fetchedAt: 1 } })
    .toArray()

  let matched = 0
  let unmatched = 0
  const byIp = new Map<string, number>()

  for (const doc of docs) {
    const [hit] = await activity
      .find({
        word: doc.word,
        sourceLang: doc.sourceLang,
        targetLang: doc.targetLang,
        tier: { $in: ['llm', 'dictionary'] },
        // Older activity would give an IP that is already past retention.
        ts: { $gte: new Date(Date.now() - CREATOR_IP_RETENTION_MS), $lte: new Date(doc.fetchedAt.getTime() + SLACK_MS) },
      })
      .sort({ ts: -1 })
      .limit(1)
      .toArray()

    if (!hit) {
      unmatched++
      continue
    }
    matched++
    const createdBy: EntryCreator = {
      ip: normalizeIp(hit.ip),
      // Only bots' UAs are ever stored (privacy.activityP1).
      ...(hit.ua && hit.device?.type === 'bot' ? { ua: hit.ua } : {}),
      device: hit.device,
      channel: hit.channel,
      at: hit.ts,
      inferred: true,
    }
    byIp.set(createdBy.ip!, (byIp.get(createdBy.ip!) ?? 0) + 1)
    if (apply) {
      await translations.updateOne({ _id: doc._id, createdBy: { $exists: false } }, { $set: { createdBy } })
    }
  }

  console.log(
    `[backfill] ${docs.length} entries without createdBy: ${matched} matched, ${unmatched} with no activity record.` +
      (apply ? ' Written.' : ' Dry run; pass --apply to write.')
  )
  const top = [...byIp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  for (const [ip, n] of top) console.log(`  ${String(n).padStart(6)}  ${ip}`)

  process.exit(0)
}

main().catch((err) => {
  console.error('[backfill] failed:', err)
  process.exit(1)
})
