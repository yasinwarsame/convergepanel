# ConvergePanel Verify — Chrome Extension

A lightweight Chrome extension that lets you highlight text on any webpage, right-click, and send it to ConvergePanel for verification.

## What It Does

- Adds a **"Verify with ConvergePanel"** option to the right-click context menu when text is selected.
- Opens the ConvergePanel verification page with the selected text prefilled.
- Stores the last selected text locally so you can re-verify from the popup.

## Installation (Local Development)

1. Open **chrome://extensions** in your Chrome browser.
2. Enable **Developer Mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Select the `/extension` folder from this project.
5. The extension icon should appear in your toolbar.

## Testing

1. Navigate to any webpage.
2. Highlight any text (a claim, quote, or statement).
3. Right-click the highlighted text.
4. Click **"Verify with ConvergePanel"** in the context menu.
5. A new tab opens at `convergepanel.com/verify` with the text prefilled.

You can also click the extension icon to see the popup with:
- A preview of your last highlighted text.
- A button to re-verify it.
- A button to open ConvergePanel directly.

## File Overview

| File | Purpose |
|------|---------|
| `manifest.json` | Extension configuration (Manifest V3) |
| `background.js` | Service worker: context menu + tab opening |
| `content.js` | Placeholder for future page integrations |
| `popup.html` | Popup UI markup and styles |
| `popup.js` | Popup logic: reads storage, handles buttons |
| `icons/` | Extension icons (see note below) |

## Icons

The extension expects `icons/icon128.png` (128x128px). Before publishing to the Chrome Web Store, add a proper icon. For local development, Chrome will use a default placeholder if the icon file is missing.

## Notes

- This MVP opens the main ConvergePanel web app — it does not call an internal API directly.
- No host permissions are required since the extension only opens tabs.
- The `content.js` script is injected but does not modify pages in this version.
- Permissions are kept minimal: `contextMenus`, `storage`, `activeTab`.

## Future Enhancements

- Inline verification tooltips on the page.
- Direct API calls to ConvergePanel backend.
- Badge showing verification status.
- Support for images and screenshots.
