import { useEffect } from 'react'

interface DocumentMeta {
  title: string
  description?: string
  /** Absolute canonical URL. Word pages always canonicalize to the plain
   *  /word/:term path (en→en) regardless of ?from=/&to= — see to-do §5. */
  canonical?: string
  /** Pages that shouldn't be indexed (e.g. per-browser history). */
  noindex?: boolean
}

function setMetaTag(name: string, content: string): void {
  let el = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)
  if (!el) {
    el = document.createElement('meta')
    el.setAttribute('name', name)
    document.head.appendChild(el)
  }
  el.setAttribute('content', content)
}

function setCanonicalLink(href: string | undefined): void {
  const existing = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')
  if (!href) {
    existing?.remove()
    return
  }
  const el = existing ?? document.createElement('link')
  el.setAttribute('rel', 'canonical')
  el.setAttribute('href', href)
  if (!existing) document.head.appendChild(el)
}

function setRobotsMeta(noindex: boolean): void {
  const existing = document.querySelector<HTMLMetaElement>('meta[name="robots"]')
  if (!noindex) {
    existing?.remove()
    return
  }
  const el = existing ?? document.createElement('meta')
  el.setAttribute('name', 'robots')
  el.setAttribute('content', 'noindex')
  if (!existing) document.head.appendChild(el)
}

/** Sets document.title + <meta name="description"> + canonical link for the
 *  current page. Every routed page calls this with its own values (rather
 *  than restoring on unmount) so navigation always leaves the head correct. */
export function useDocumentMeta({ title, description, canonical, noindex }: DocumentMeta): void {
  useEffect(() => {
    document.title = title
    if (description !== undefined) setMetaTag('description', description)
    setCanonicalLink(canonical)
    setRobotsMeta(Boolean(noindex))
  }, [title, description, canonical, noindex])
}
