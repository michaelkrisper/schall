# Security and privacy

## What the app does with your data

- The microphone signal is processed on the device only, inside the browser.
  Nothing is uploaded; the app has no backend and makes no requests other
  than loading its own files from GitHub Pages.
- Recordings are stored in the browser's IndexedDB on the device and leave
  it only when you download or share them.
- Settings (weighting, calibration) are stored in `localStorage`.
- No analytics, no cookies, no third-party scripts.

Removing the app's site data in the browser deletes recordings and settings.

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's
[private vulnerability reporting](https://github.com/michaelkrisper/schall/security/advisories/new)
instead. You will get an answer within a few days.

Only the latest version (the deployed `main` branch) is supported.
