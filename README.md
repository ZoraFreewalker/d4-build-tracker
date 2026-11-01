# D4 Build Tracker

Overlay voor Diablo IV: plak een Maxroll-buildlink en zie tijdens het spelen je gear-voortgang, skills en paragon.

## Installeren
Start `dist/D4-Build-Tracker-Setup-<versie>.exe` (of download hem van GitHub Releases). Windows SmartScreen waarschuwt omdat de app niet ondertekend is:
**Meer info → Toch uitvoeren**. Zet Diablo IV op **borderless/windowed** (Engelse client).

## Gebruik
- Eerste start: het beheervenster opent → plak een link (`https://maxroll.gg/d4/build-guides/…`, planner-link of ID).
- Overlay-tabbladen: **Gear** (live item-vergelijking + wat elk slot nodig heeft), **Skills** (skill bar, nodes met
  rank, leveling-stappen met ★ voor nieuw), **Paragon** (per board, met glyph en rotatie).
- ⠿ slepen = verplaatsen; randen en hoeken slepen = vergroten/verkleinen zoals een Windows-venster (breedte schaalt de tekst, hoogte toont meer van de lijst); ⚙ = beheervenster. Tray-icoon voor dezelfde opties en Afsluiten.
- Sneltoetsen (aan te passen): `Alt+Shift+I` bedienmodus (overlay vrij klikken/scrollen, spel gedimd; Esc = terug), `Alt+Shift+O` overlay aan/uit, `Alt+Shift+B` alle paragon boards groot.
- Updates: de geïnstalleerde app haalt nieuwe versies automatisch op van GitHub Releases en installeert ze bij afsluiten (of via "Nu herstarten").
- Equipped items tellen mee zodra je ze in je character-scherm hovert.

Data staat in `%APPDATA%\D4 Build Tracker` (builds, voortgang, speldata-cache, `debug/` met onherkende tooltips).

## Ontwikkelen
```
npm start                          # dev
npm start -- --image <screenshot>  # overlay testen zonder game
npm test
npm run dist                       # installer → dist/
```
Dev-variabelen: `D4_USER_DATA` (los profiel), `D4_SNAPSHOT_DIR` (PNG's van de eigen vensters),
`D4_TAB` (`skills`/`paragon`), `D4_DETAIL=1`, `D4_CONTROL_JS` (beheervenster aansturen).

Bouwt `npm run dist` niet vanwege "Cannot create symbolic link" (winCodeSign): pak het archief uit
`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\*.7z` uit naar `winCodeSign-2.6.0` in dezelfde map.

Spec: [SPEC.md](SPEC.md) · Onderzoek: [docs/RESEARCH.md](docs/RESEARCH.md)
