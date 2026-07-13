# Chrome Web Store Submission Notes

Reference material for the Chrome Web Store developer dashboard submission
form (design doc §10, `Chrome-extension-to-do-list.md` Phase 7). Nothing here
is read by the extension itself — it's copy to paste into the dashboard.

## Privacy policy

**URL:** `https://dict.ai-dictionary.org/privacy` (also linked from the
options page). Source: `src/pages/PrivacyPage.tsx`.

## Single purpose description

> Open Dictionary lets you look up the definition of any word or phrase —
> by highlighting it on a page, right-clicking it, or typing it into the
> toolbar popup. That's the only thing it does.

## Permission justifications

Paste one paragraph per requested permission into the corresponding review
form field.

- **`contextMenus`** — Adds a "Look up '%s' in Open Dictionary" item to the
  right-click menu when text is selected on a page. This is one of the two
  ways (along with the selection icon) a user triggers a lookup.

- **`storage`** — Stores the user's language-pair and selection-icon
  preferences (`chrome.storage.sync`, a few bytes) and a local response
  cache for previously looked-up words (`chrome.storage.local`), so repeat
  lookups of the same word don't need a new network request. No page
  content or browsing history is ever stored.

- **`scripting`** — Used only to render the result card after a right-click
  lookup (`chrome.scripting.executeScript`, scoped to the clicked tab via
  `activeTab`). The lookup itself already happened in the background
  worker before this injection; the injected code only displays the
  already-fetched result.

- **`activeTab`** — Scopes the on-demand result-card injection above to the
  single tab the user right-clicked in, instead of requesting a permission
  applicable to all tabs.

- **Content script matching `<all_urls>`** — Needed to detect when a user
  highlights text on any page, so the lookup icon can appear next to the
  selection. The script only ever reads `window.getSelection()` — it does
  not read, store, or transmit any other page content, and it takes no
  action until the user clicks the icon or invokes the right-click menu on
  their own selected text. Users who prefer not to run this listener can
  disable it in the options page ("Show icon on text selection" toggle),
  which still leaves the right-click lookup path fully functional.

- **`host_permissions` (`dict.ai-dictionary.org`, and `localhost:3001` for
  local development)** — The only network destination the background
  worker ever calls, to fetch dictionary/translation results for the text
  the user explicitly selected or typed.

## What data is sent, in plain language

Only the text a user explicitly selects or types, plus their chosen
source/target language codes, sent to the same public lookup endpoint the
website itself uses. No URL, page content beyond the selection, cookies,
or browsing history ever leaves the browser. See the privacy policy above
for the full statement.

## Store listing copy (draft)

**Short description** (≤132 chars):

> Look up any word instantly — highlight it, right-click it, or search it.
> No ads, no tracking.

**Long description:**

> Open Dictionary turns any webpage into a dictionary. Highlight a word or
> phrase and a small lookup icon appears right next to it — click it for an
> instant definition, phonetic spelling, CEFR-graded example sentences, and
> (if you want) a translation, without leaving the page.
>
> Three ways to look something up:
> - **Highlight it** — a small icon appears next to your selection.
> - **Right-click it** — choose "Look up in Open Dictionary" from the
>   context menu.
> - **Type it** — click the toolbar icon for a quick manual search.
>
> Choose your source and target language in the options page, or leave both
> as English to see definitions only.
>
> Privacy: the extension only ever sends the text you explicitly select or
> type, plus your language choice, to our lookup API. It never reads or
> transmits page URLs, other page content, cookies, or browsing history —
> no ads, no analytics, no trackers. Full privacy policy:
> https://dict.ai-dictionary.org/privacy

**Screenshots to capture** (1280×800 or 640×400, per Chrome Web Store spec):
1. Selection icon appearing next to a highlighted word on a real page.
2. The result card open, showing a definition.
3. The right-click context menu with the "Look up" item visible.
4. The toolbar popup with a manual search result.
5. The options page (language pickers + toggle).

## Icons

Already generated (Phase 1) at `extension/public/icons/{16,32,48,128}.png`
from `public/favicon.svg`. The Chrome Web Store additionally wants a
**128×128 "store icon"** on the listing page itself — the same `128.png`
file is reused for that upload.

## Pre-submission checklist

- [ ] Re-verify `ALLOWED_ORIGINS` includes the **published** extension ID
      once assigned by the Chrome Web Store (may differ from the pinned dev
      ID `mliclnamclidbemdcahklcdoikncablf` — see `extension/README.md` and
      design doc §13.1). Keep both IDs in `ALLOWED_ORIGINS` during the
      transition, then drop the dev ID once fully cut over.
- [ ] Confirm the production API round-trips correctly from a freshly
      packed (not unpacked) build before submitting.
- [ ] Confirm the privacy policy URL above is live and matches this
      document before pasting it into the dashboard.
