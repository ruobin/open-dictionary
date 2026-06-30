/**
 * Standalone smoke test for the LLM provider wiring. Run with:
 *   npm run llm:ping                 # pings "serendipity" en->en
 *   npm run llm:ping -- huevos       # custom term
 *   LLM_PING_TARGET_LANG=es npm run llm:ping -- serendipity
 */
import 'dotenv/config'
import { config as loadEnvFile } from 'dotenv'
import { createLlmProviderFromEnv, LlmProviderError } from '../server/providers/llm'

loadEnvFile({ path: 'server/.env' })

async function main(): Promise<void> {
  const { provider, status, message } = createLlmProviderFromEnv()
  console.log(`[llm:ping] ${status} — ${message}`)
  if (!provider) {
    console.error('[llm:ping] No provider configured. Set LLM_VENDOR and a vendor API key.')
    process.exit(1)
  }

  const text = process.argv[2] ?? 'serendipity'
  const sourceLang = process.env.LLM_PING_SOURCE_LANG ?? 'en'
  const targetLang = process.env.LLM_PING_TARGET_LANG ?? 'en'

  console.log(`[llm:ping] "${text}" (${sourceLang} -> ${targetLang}) via ${provider.id}`)
  const started = Date.now()
  try {
    const result = await provider.translate({ text, sourceLang, targetLang })
    console.log(`[llm:ping] ok in ${Date.now() - started}ms`)
    console.log(JSON.stringify(result.content, null, 2))
  } catch (err) {
    console.error(`[llm:ping] FAILED in ${Date.now() - started}ms`)
    if (err instanceof LlmProviderError) {
      console.error(
        JSON.stringify(
          { name: err.name, code: err.code, status: err.status, message: err.message },
          null,
          2
        )
      )
    } else {
      console.error(err)
    }
    process.exit(1)
  }
}

void main()
