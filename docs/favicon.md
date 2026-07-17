# Favicon & icon assets

The **source of truth** for the app icon is a single SVG:
[`public/favicon.svg`](../public/favicon.svg) — a 64×64 red rounded square with a
white serif **"ai"** ligature (`viewBox="0 0 64 64"`).

Everything else is a **raster derivative** regenerated from that SVG:

| File | Size | Format | Notes |
|---|---|---|---|
| `public/favicon.svg` | 64×64 | SVG | Source of truth. Referenced directly by `index.html`. |
| `public/favicon.png` | 128×128 | PNG | Transparent corners (the area outside the `rx="12"` rect). Use wherever transparency matters. |
| `public/favicon.jpeg` | 128×128 | JPEG | White-filled corners (JPEG has no alpha). Use only where JPEG is required. |

`index.html` wires the SVG in directly:

```html
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
```

The PNG/JPEG derivatives exist for legacy browsers, store listings, social/OG
imagery, and the Chrome Web Store icon set (`extension/public/icons/*.png` —
same recipe, see **§Extension store icons** below).

---

## Prerequisite: `librsvg` (`rsvg-convert`)

macOS's built-in `sips` *can* convert an SVG, but it **mis-renders the SVG
`viewBox` and `<text>`**, producing off-center output (and sometimes drops the
text entirely). Use [`librsvg`](https://wiki.gnome.org/Projects/LibRsvg)'s
`rsvg-convert` instead — it respects the `viewBox`, centers correctly, and
renders `<text>` reliably.

```bash
brew install librsvg     # one-time
```

---

## Regenerate the PNG (recommended — supports transparency)

```bash
rsvg-convert -w 128 -h 128 -f png public/favicon.svg -o public/favicon.png
```

Single step. Corners stay transparent.

---

## Regenerate the JPEG

`rsvg-convert` **cannot emit JPEG directly** (its outputs are PNG / PDF / PS /
EPS / SVG only). So render to PNG first, then transcode to JPEG with `sips`.
The transcoding step is a lossless re-encode of an already-correctly-centered
PNG, so centering is preserved:

```bash
rsvg-convert -w 128 -h 128 -f png public/favicon.svg -o /tmp/favicon.png
sips -s format jpeg /tmp/favicon.png --out public/favicon.jpeg
```

> **JPEG caveat:** JPEG has no alpha channel. The rounded corners of the red
> square (the area outside the rect's `rx="12"`) render as **solid white**, not
> transparent. If you need transparent corners, ship the PNG instead.

---

## Extension store icons (16 / 32 / 48 / 128)

The Chrome extension ships its own fixed-size icon set in
[`extension/public/icons/`](../extension/public/icons/). They are regenerated
from the **same** `public/favicon.svg` with the **same** `rsvg-convert` recipe,
just at four sizes:

```bash
for s in 16 32 48 128; do
  rsvg-convert -w "$s" -h "$s" -f png public/favicon.svg -o "extension/public/icons/$s.png"
done
```

The extension manifest references `icons/16.png`, `32.png`, `48.png`,
`128.png` — see [`extension/RELEASE.md`](../extension/RELEASE.md) §4.4
("Store listing assets") for where each is consumed.

---

## Why not just use `sips` directly?

A one-step conversion looks temptingly simple:

```bash
# ⚠️ DO NOT USE — produces off-center / text-less output
sips -s format jpeg -z 128 128 public/favicon.svg --out public/favicon.jpeg
```

It runs without error and emits a 128×128 JPEG, but the output is broken in two
ways:

1. **Off-center content** — with no explicit `width`/`height` on the SVG,
   `sips` rasterizes at a non-square default canvas (typically 300×150) and
   then resamples to 128×128, throwing off centering.
2. **Unreliable `<text>` rendering** — `sips`'s SVG text support is incomplete;
   the `"ai"` ligature may be missing or misplaced.

Adding explicit `width="128" height="128"` to the SVG works around the
centering issue but not the text issue. **Always render via `rsvg-convert`
first** — it handles both correctly with no SVG edits required.
