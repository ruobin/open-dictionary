/**
 * Lightweight eval harness (to-do §4): runs a fixed set of tricky words
 * against the LIVE LLM (no cache — always hits the model fresh) and checks
 * structural properties of the adapted entry. Meant to be run by hand before
 * bumping CACHE_VERSION on a prompt/schema change, to catch regressions like
 * the ones found manually during to-do §3 (a hallucinated `translation` in
 * same-language mode, annotated collocations). NOT wired into automatic CI —
 * it costs real LLM calls each run, same reasoning as scripts/llm-ping.ts.
 *
 * Usage: npm run eval
 */
import { createLlmProviderFromEnv, type LlmTranslationContent } from '../server/providers/llm'
import { adaptLlm } from '../server/translate'
import { EVAL_CASES, type EvalContext } from './eval-cases'

async function main(): Promise<void> {
  const { provider, status, message } = createLlmProviderFromEnv()
  console.log(`[eval] ${status} — ${message}`)
  if (!provider) {
    console.error('[eval] No provider configured. Set LLM_VENDOR and a vendor API key.')
    process.exit(1)
  }

  let passed = 0
  let failed = 0

  for (const testCase of EVAL_CASES) {
    const sourceLang = testCase.sourceLang ?? 'en'
    const targetLang = testCase.targetLang ?? 'en'
    process.stdout.write(`"${testCase.word}" (${testCase.note}) ... `)

    try {
      const result = await provider.translate({ text: testCase.word, sourceLang, targetLang })
      const content = result.content as LlmTranslationContent
      const [entry] = adaptLlm(content)
      const ctx: EvalContext = {
        entry,
        isTypo: Boolean(entry.typo?.suggestion),
        typoSuggestion: entry.typo?.suggestion,
      }

      const failures = testCase.checks.map((check) => check(ctx)).filter((f): f is string => f !== null)
      if (failures.length === 0) {
        console.log('PASS')
        passed += 1
      } else {
        console.log('FAIL')
        for (const f of failures) console.log(`    - ${f}`)
        failed += 1
      }
    } catch (err) {
      console.log('ERROR')
      console.log(`    - ${err instanceof Error ? err.message : String(err)}`)
      failed += 1
    }
  }

  console.log(`\n[eval] ${passed}/${EVAL_CASES.length} passed`)
  process.exit(failed > 0 ? 1 : 0)
}

void main()
