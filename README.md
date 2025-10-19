# TabEater

Minimal browser extension for taming runaway tab collections.

---

## Features

- Close matching tabs by keyword, domain, or in bulk
- Get suggestions for the next tabs to archive
- Switch between dark and light themes per browser
- Track how many tabs you clear over time

---

## Build

PowerShell script (no Node required):

```powershell
.\build.ps1             # build all browsers (firefox, chrome, edge)
.\build.ps1 firefox     # build a single target
```

Node 18+ workflow (optional for CI/other devs):

```bash
node build.js           # build all browsers
node build.js firefox   # build a single target
```

Artifacts are written to `dist/<browser>/`.

---

## Project Layout

```
src/
  shared/                # all common scripts, UI, and assets
  overrides/
    chrome/              # manifest + files that differ for Chrome
    edge/                # manifest + files that differ for Edge
    firefox/             # manifest + files that differ for Firefox
```

Override folders are copied on top of the shared build output so each browser only diverges where it needs to.

---

## Install (temporary/dev build)

**Firefox**

1. Visit `about:debugging#/runtime/this-firefox`
2. Choose **Load Temporary Add-on**
3. Select `dist/firefox/manifest.json`

**Chrome / Chromium**

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Choose **Load unpacked** and pick `dist/chrome/`

Add screenshots to `docs/screenshots/` to populate the extension gallery later.
