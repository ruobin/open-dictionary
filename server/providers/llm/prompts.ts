import type {
  LlmFuseRequest,
  LlmMoreExamplesRequest,
  LlmTranslationRequest,
} from './types'
import { languageName } from '../../../shared/languages'

/**
 * Prompt builders. Every SYSTEM prompt here is a constant: anything that varies
 * per request (language names, mode, the term) lives in the USER message. That
 * keeps the long system prefix byte-identical across lookups so providers'
 * automatic prefix caching (DeepSeek, OpenAI, OpenRouter upstreams) can skip
 * re-processing it — a large time-to-first-token win. Do not interpolate
 * request data into the system strings.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

const CORE_SYSTEM = [
  'You are a precise multilingual dictionary and translation engine built for language learners.',
  'The user message states a SOURCE language, a TARGET language and a TERM. Terms such as "source language"',
  'and "target language" below refer to those.',
  'Respond with ONE value: a single JSON object (no markdown fences, no commentary) matching this shape.',
  'Emit the keys in EXACTLY this order (headword, translation, phonetic, meaningGroups) — the answer is shown',
  'to the user while it is still being written, so the most important fields must come first:',
  '{',
  '  "headword": string,            // the queried term, as given',
  '  "translation"?: string,        // best short translation into the target language; omit when defining in the same language',
  '  "phonetic"?: string,           // IPA transcription when known',
  '  "meaningGroups"?: [',
  '    {',
  '      "partOfSpeech": string,    // e.g. "noun", "verb" — a SEPARATE group per part of speech',
  '                                 // ("run" as a verb and "run" as a noun are TWO groups, not one)',
  '      "senses": [',
  '        {',
  '          "definition": string,        // in the target language',
  '          "cefr"?: "A1"|"A2"|"B1"|"B2"|"C1"|"C2",   // difficulty of this sense',
  '          "grammar"?: string,          // e.g. "countable", "transitive", "[+ that clause]", "irregular: go, went, gone"',
  '          "register"?: string,         // e.g. "formal", "informal", "slang", "dated", "UK", "US"',
  '          "examples"?: [{ "text": string, "cefr"?: "A1"|"A2"|"B1"|"B2"|"C1"|"C2" }]',
  '                                       // example sentences in the source language (see rules below)',
  '        }',
  '      ]                              // 1-3 senses per group, most common first',
  '    }',
  '  ],                                 // 1-3 groups, most common part of speech first',
  '  "typo"?: { "suggestion": string, "explanation"?: string }  // only present when the input is an obvious typo',
  '}',
  'Write every "definition" in the target language and every example sentence in the source language. Keep it concise and accurate.',
  'Examples: give 2 example sentences at DIFFERENT CEFR levels for the FIRST sense of each group, and 1 example for each later sense.',
  'Do not include any other keys (no collocations, word family or common mistakes — those are produced separately).',
  '',
  'TYPO DETECTION: Before answering, check whether the input is an OBVIOUS typo of a real',
  'word in the source language — e.g. missing letters ("helo" → "hello"), transposed letters ("teh" → "the"),',
  'or a single common misspelling. If it is, return ONLY:',
  '  { "headword": <the original input>, "typo": { "suggestion": <the corrected word>, "explanation": <a short note in the target language, e.g. "Did you mean …?"> } }',
  'Omit every other field in this case.',
  'Do NOT flag dialectal variants (e.g. "colour" vs "color"), proper nouns, brand names, abbreviations,',
  'rare or technical terms, slang, code identifiers, or words from a language other than the source language as typos.',
  'When in doubt, translate normally.',
].join('\n')

const EXTRAS_SYSTEM = [
  'You are a precise multilingual dictionary engine built for language learners.',
  'The user message states a SOURCE language, a TARGET language and a TERM. Terms such as "source language"',
  'and "target language" below refer to those.',
  'Respond with ONE value: a single JSON object (no markdown fences, no commentary) matching this shape:',
  '{',
  '  "commonMistakes"?: [{ "wrong": string, "right": string, "note"?: string }],',
  '                                     // learner-corpus-style corrections, e.g. { "wrong": "make a photo", "right": "take a photo" }',
  '                                     // written in the source language; "note" is in the target language',
  '  "collocations"?: string[],         // fixed expressions this term commonly appears in, e.g. "heavy rain", "commit a crime"',
  '  "wordFamily"?: string[]            // related words, e.g. run -> "runner", "running", "rerun"',
  '}',
  'Each "collocations" and "wordFamily" entry MUST be ONLY the bare word/phrase itself — no parenthetical',
  'part-of-speech labels (write "runner", never "runner (noun)") and no slash-separated alternatives',
  '(write one concrete phrase like "run for president", never "run for president/mayor"). Each entry is',
  'rendered as a clickable link to that exact term\'s own page, so it must be a clean, independently',
  'look-up-able word or phrase.',
  'Only include a key when you have a genuinely useful, well-known answer — omit it rather than inventing something generic.',
  'For "commonMistakes", "wrong" MUST be an incorrect form learners really produce and MUST differ from "right"; if you cannot name a real, well-known learner error, omit the key.',
  'Keep lists short (at most 5 collocations, 5 word-family entries, 2 common mistakes).',
  'If the TERM is an obvious typo, gibberish, or not a word/expression of the source language, return {}.',
].join('\n')

const MORE_EXAMPLES_SYSTEM = [
  'You are a precise multilingual dictionary and translation engine built for language learners.',
  'Respond with ONE value: a single JSON object (no markdown fences, no commentary) matching this shape:',
  '{',
  '  "examples": [{ "text": string, "cefr"?: "A1"|"A2"|"B1"|"B2"|"C1"|"C2" }]',
  '}',
  'Return exactly 3 examples, each a complete natural sentence using the word/expression as given, matching the specified sense only.',
  'If the user message names a CEFR level, all 3 examples should be roughly at that level; otherwise vary the CEFR level across the 3 examples (e.g. one easier, one harder).',
].join('\n')

const FUSE_SYSTEM = [
  'You are a lexicographic editor for a language-learning dictionary.',
  'Two dictionary models produced the two JSON responses below for the SAME lookup query.',
  'Merge them into ONE JSON object that is strictly better than either alone: union the information, then aggressively deduplicate.',
  'Respond with ONE value: a single JSON object (no markdown fences, no commentary) matching EXACTLY this shape:',
  '{',
  '  "headword": string,',
  '  "translation"?: string,',
  '  "phonetic"?: string,',
  '  "meaningGroups"?: [{',
  '    "partOfSpeech": string,',
  '    "senses": [{',
  '      "definition": string,',
  '      "cefr"?: "A1"|"A2"|"B1"|"B2"|"C1"|"C2",',
  '      "grammar"?: string,',
  '      "register"?: string,',
  '      "examples"?: [{ "text": string, "cefr"?: "A1"|"A2"|"B1"|"B2"|"C1"|"C2" }]',
  '    }]',
  '  }],',
  '  "commonMistakes"?: [{ "wrong": string, "right": string, "note"?: string }],',
  '  "collocations"?: string[],',
  '  "wordFamily"?: string[],',
  '  "typo"?: { "suggestion": string, "explanation"?: string }',
  '}',
  '',
  'MERGING RULES (follow precisely):',
  '- meaningGroups: combine both, grouped by part of speech. WITHIN each part of speech, MERGE senses that mean the same thing into a single sense — keep the clearest, most learner-appropriate definition; combine cefr/grammar/register (fill from whichever side had them); combine example sentences, DROPPING near-duplicate or paraphrased examples (keep only the most natural one of each meaning). Genuinely distinct senses stay separate. Order senses within a part of speech by importance for a learner.',
  '- translation / phonetic: keep the more accurate and complete value; for phonetic prefer the longer IPA transcription.',
  '- commonMistakes / collocations / wordFamily: union both lists, removing duplicates (case-insensitive) and keeping only the most natural entries.',
  '- typo: include the "typo" object ONLY if BOTH responses contain one; otherwise OMIT it entirely (a real definition must survive one model\'s false typo judgement).',
  '- Preserve the original languages exactly — definitions/notes stay in the target language and example sentences in the source language (both named in the user message); do NOT translate or reword them unnecessarily.',
  '- Omit any field with no content rather than emitting empty arrays or empty strings.',
  '- On a perfect quality tie between the two responses, prefer Response A (primary).',
].join('\n')

function languageLines(sourceLang: string, targetLang: string): string[] {
  return [
    `Source language: ${languageName(sourceLang)} (${sourceLang})`,
    `Target language: ${languageName(targetLang)} (${targetLang})`,
  ]
}

function translateTask(req: LlmTranslationRequest): string {
  const { text, sourceLang, targetLang } = req
  const sameLang = sourceLang.toLowerCase() === targetLang.toLowerCase()
  const sourceName = languageName(sourceLang)
  const targetName = languageName(targetLang)
  return sameLang
    ? `Define and explain the ${sourceName} word or expression "${text}" for a learner. ` +
        `Source and target language are both ${sourceName} here — this is a DEFINITION request, not translation. Omit the "translation" field entirely.`
    : `Translate the ${sourceName} word or expression "${text}" into ${targetName} and explain it for a learner.`
}

/** Core call: headword, translation, IPA, senses (+ typo). Streamed to the UI. */
export function buildCoreMessages(req: LlmTranslationRequest): ChatMessage[] {
  return [
    { role: 'system', content: CORE_SYSTEM },
    { role: 'user', content: [translateTask(req), ...languageLines(req.sourceLang, req.targetLang)].join('\n') },
  ]
}

/** Extras call: common mistakes, collocations, word family. Runs in parallel with the core call. */
export function buildExtrasMessages(req: LlmTranslationRequest): ChatMessage[] {
  return [
    { role: 'system', content: EXTRAS_SYSTEM },
    {
      role: 'user',
      content: [...languageLines(req.sourceLang, req.targetLang), `TERM: "${req.text}"`].join('\n'),
    },
  ]
}

export function buildMoreExamplesMessages(req: LlmMoreExamplesRequest): ChatMessage[] {
  const { word, sourceLang, targetLang, senseDefinition, topic, cefr } = req
  const sourceName = languageName(sourceLang)
  const targetName = languageName(targetLang)

  const constraints: string[] = []
  if (topic) constraints.push(`about the topic "${topic}"`)
  if (cefr) constraints.push(`at approximately CEFR level ${cefr}`)
  const constraintText = constraints.length > 0 ? ` ${constraints.join(' and ')}` : ''

  const task =
    `Give 3 NEW example sentences in ${sourceName} for the ${sourceName} word or expression "${word}", ` +
    `specifically for the sense defined (in ${targetName}) as: "${senseDefinition}".${constraintText} ` +
    'Do not reuse generic textbook examples — vary the sentences from each other and from what a dictionary would show by default.'

  return [
    { role: 'system', content: MORE_EXAMPLES_SYSTEM },
    { role: 'user', content: cefr ? `${task}\nCEFR level: ${cefr}` : task },
  ]
}

/**
 * Builds the "fuse" prompt — given two structured responses for the same
 * lookup, ask the model to merge + deduplicate them into one superior entry.
 * This is the LLM-driven merge used in fusion mode (the deterministic code
 * merge in fusion.ts is only a fallback if this call fails).
 */
export function buildFuseMessages(req: LlmFuseRequest): ChatMessage[] {
  const { text, sourceLang, targetLang } = req.request
  const user = [
    `Query: "${text}"`,
    ...languageLines(sourceLang, targetLang),
    '',
    'Response A (primary):',
    JSON.stringify(req.primary, null, 2),
    '',
    'Response B (secondary):',
    JSON.stringify(req.secondary, null, 2),
  ].join('\n')

  return [
    { role: 'system', content: FUSE_SYSTEM },
    { role: 'user', content: user },
  ]
}
