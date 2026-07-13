/** Transient `chrome.storage.local` key the on-demand context-menu render
 *  script (`extension/src/content/contextMenuRender.tsx`) reads immediately
 *  after injection, then deletes. Avoids a message-passing race between
 *  `chrome.scripting.executeScript` finishing injection and the lookup
 *  result actually being ready — the background worker writes the result
 *  *before* triggering injection (design doc §3.2, "Phase 4"). */
export const PENDING_RESULT_KEY = 'pendingContextMenuResult'
