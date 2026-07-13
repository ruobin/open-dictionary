/**
 * Shared CSS for the Shadow-DOM-mounted result card, injected as a
 * `<style>` element inside the shadow root. Kept as a plain string (not a
 * CSS module) so it can be trivially inlined into any shadow root without
 * relying on Vite's CSS-in-JS pipeline reaching into extension bundles.
 */
export const entryStyles = `
  * { box-sizing: border-box; }
  .od-card {
    position: relative;
    width: 320px;
    max-height: 420px;
    overflow-y: auto;
    background: #ffffff;
    color: #1a1a1a;
    border: 1px solid #d9d9d9;
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
    padding: 12px 14px;
    font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .od-close {
    position: absolute;
    top: 6px;
    right: 8px;
    background: none;
    border: none;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    color: #666;
    padding: 2px 6px;
  }
  .od-close:hover { color: #111; }
  .od-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; padding-right: 20px; }
  .od-word { font-weight: 700; font-size: 16px; }
  .od-phonetic { color: #777; font-size: 13px; }
  .od-translation { font-style: italic; color: #b81b21; margin-bottom: 8px; }
  .od-meaning { margin-bottom: 8px; }
  .od-pos { font-weight: 600; font-size: 12px; text-transform: uppercase; color: #555; margin-bottom: 2px; }
  .od-def { margin-bottom: 3px; }
  .od-cefr {
    display: inline-block;
    font-size: 10px;
    font-weight: 700;
    padding: 1px 4px;
    border-radius: 3px;
    background: #eee;
    color: #444;
    margin-right: 4px;
  }
  .od-link { display: inline-block; margin-top: 6px; color: #b81b21; text-decoration: none; font-size: 13px; }
  .od-link:hover { text-decoration: underline; }
  .od-error { color: #a33; padding: 8px 0; }
  .od-icon-btn {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 1px solid #d9d9d9;
    background: #ffffff;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    font-size: 14px;
    line-height: 1;
  }
  .od-icon-btn:hover { background: #f5f5f5; }
  .od-loading { padding: 8px 4px; color: #555; }
  .od-fav-btn {
    margin-left: auto;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    color: #b8860b;
    padding: 0 2px;
  }
`
