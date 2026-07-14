/** Escapes regex metacharacters so untrusted user input can be safely used
 *  inside a Mongo `$regex` filter (anchored prefix matches, e.g. `^word`)
 *  without either erroring on invalid regex syntax or letting the caller
 *  inject arbitrary regex behavior. Shared by `server/suggest.ts` (word
 *  autocomplete) and `server/admin/entries.ts` (admin entry search). */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
