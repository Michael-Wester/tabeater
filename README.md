# TabEater

Browser extension to close noisy tabs fast and keep your tab list tidy.

<img width="911" height="546" alt="image" src="https://github.com/user-attachments/assets/cbb89ca3-851e-4c0a-8a8f-5a78e485d726" />

## Highlights

- Close tabs by keyword or exact domain, with suggestions for busy sites.
- One-click cleanup for inactive tabs, duplicates, and domain-heavy windows.
- Undo the last close, track total tabs eaten, and toggle light/dark themes.
- Context menu entry to close tabs for the current site.

## Usage

- Open the popup, type a keyword or domain, then press Enter or click Close.
- Tap a suggestion chip to close tabs for that site (or inactive tabs).
- Use quick actions to sort tabs, close duplicates, or undo the last close.
- Adjust the minimum tab count for suggestions and the inactive threshold in Settings.

## Build

PowerShell (no Node needed):

```powershell
.\build.ps1             # all browsers
.\build.ps1 firefox     # single target
```

Node 18+ (optional):

```bash
node build.js           # all browsers
node build.js firefox   # single target
```

Outputs land in `dist/<browser>/`.

## Install (temporary/dev)

- **Firefox:** `about:debugging` -> This Firefox -> Load Temporary Add-on -> `dist/firefox/manifest.json`
- **Chrome/Chromium:** `chrome://extensions` -> Developer mode -> Load unpacked -> `dist/chrome/`
- **Edge:** `edge://extensions` -> Developer mode -> Load unpacked -> `dist/edge/`

## Layout

```
src/
  shared/      # common scripts, UI, assets
  overrides/   # browser-specific manifest/files (chrome, edge, firefox)
```
