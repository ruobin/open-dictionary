export interface BrowsePageData {
  letter: string
  letters: string[]
  words: string[]
  page: number
  totalPages: number
}

export type BrowseErrorCode = 'not_found' | 'network'

export class BrowseError extends Error {
  readonly code: BrowseErrorCode
  constructor(code: BrowseErrorCode) {
    super(code)
    this.name = 'BrowseError'
    this.code = code
  }
}

export async function fetchBrowsePage(letter: string, page: number, signal?: AbortSignal): Promise<BrowsePageData> {
  const qs = new URLSearchParams({ page: String(page) })
  let res: Response
  try {
    res = await fetch(`/api/browse/${encodeURIComponent(letter)}?${qs.toString()}`, { signal })
  } catch {
    throw new BrowseError('network')
  }
  if (res.status === 404) throw new BrowseError('not_found')
  if (!res.ok) throw new BrowseError('network')
  return (await res.json()) as BrowsePageData
}
