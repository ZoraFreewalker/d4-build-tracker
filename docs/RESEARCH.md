# Onderzoek: best practices voor een D4-overlay (2026-10-30)

## Wat bestaande tools doen
- **Mobalytics desktop (Overwolf)**: OCR van het spelvenster elke 500 ms, build tracking met % voltooiing,
  paragon board in de overlay, Plus-betaalmuur.
- **Diablo4Companion** (open source, josdemmers): importeert builds van Maxroll, D4Builds, Mobalytics,
  D2Core en InfinityBuilds, inclusief paragon. Toont affixes, aspects en een paragon-overlay. Detectie via
  screenshots + Tesseract OCR met presets per resolutie/taal/HDR. Overlay aan/uit via een knop linksboven in de game.
- **Planners (op.gg, d4guides, Maxroll)**: alleen in de browser, geen overlay.

## Richtlijnen voor overlays (Overwolf product guidelines)
- Blokkeer nooit HUD-elementen van de game; altijd een duidelijke manier om te sluiten/verbergen.
- Kleine, verplaatsbare en schaalbare panelen; ontwerp voor 1920x1080 en 2560x1440.
- Gedraag je als desktop-app, niet als website.
- Toon sneltoets-hints in de UI en laat gebruikers sneltoetsen aanpassen.
- Vermijd half-transparante panelen: minder leesbaar en slechter voor prestaties.
- Gebruikers moeten de game in **fullscreen borderless/windowed** zetten; vertel ze dat.
- Kijk anders dan de game (eigen fonts/kleuren/branding), geen kopie van de game-UI.

## Electron
- Click-through met `setIgnoreMouseEvents`; alleen interactief maken boven echte bedieningselementen.
  `{ forward: true }` installeert een systeembrede muis-hook die de muis laat haperen als het hoofdproces
  bezig is (zelf vastgesteld) → wij pollen de cursorpositie.
- `setPosition` laat vensters groeien onder Windows-schaling → `setBounds` met vaste grootte (zelf vastgesteld).

## Verpakken
- electron-builder: `nsis` (installer, standaard) of `portable`. Extra bestanden (zoals `ocr.ps1`) via
  `extraResources`, op runtime te vinden via `process.resourcesPath`.

## Bronnen
- https://dev.overwolf.com/ow-electron/guides/product-guidelines/overview
- https://dev.overwolf.com/ow-electron/guides/product-guidelines/app-screen-behavior/in-game-overlays
- https://dev.overwolf.com/ow-native/guides/product-guidelines/app-screen-behavior/app-screen-sizes
- https://dev.overwolf.com/ow-native/guides/game-compliance/overview
- https://github.com/josdemmers/Diablo4Companion
- https://1v9.gg/blog/best-diablo-4-overlay-and-companion-apps
- https://www.electronjs.org/docs/latest/tutorial/window-customization
- https://github.com/electron/electron/issues/1335
- https://www.electron.build/nsis.html
- https://www.electron.build/app-builder-lib.interface.portableoptions
