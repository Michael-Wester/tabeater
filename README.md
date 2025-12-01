# TabEater

Browser extension to close noisy tabs fast and keep your tab list tidy.

<img width="381" height="357" alt="image" src="https://github.com/user-attachments/assets/0ba91f51-7037-49a0-9f8f-d3dec866023b" />

<img width="384" height="520" alt="image" src="https://github.com/user-attachments/assets/9be1be6d-216a-4ca4-9e45-89695f863eb6" />

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
