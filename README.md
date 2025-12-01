# TabEater

Browser extension to close noisy tabs fast and keep your tab list tidy.

## Highlights
- Close tabs by keyword or domain; quick actions for inactive domains.
- Smart recommendations; light/dark theme support.
- Track total tabs cleared across time.

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
- **Firefox:** `about:debugging` → This Firefox → Load Temporary Add-on → `dist/firefox/manifest.json`
- **Chrome/Chromium:** `chrome://extensions` → Developer mode → Load unpacked → `dist/chrome/`

## Layout
```
src/
  shared/      # common scripts, UI, assets
  overrides/   # browser-specific manifest/files (chrome, edge, firefox)
```

Screenshots for stores live in `docs/screenshots/`.
