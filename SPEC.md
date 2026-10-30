# Spec: D4 Build Tracker (overlay-app)

## Objective
Een Windows-app (`.exe`) waarmee een Diablo 4-speler een build-link plakt en tijdens het spelen alles uit die
build ziet (gear, aspects, skills, paragon) **zonder de website erbij te pakken**. De gear-tracker leest
tooltips met OCR en toont of een item bij de build past.

Gebruiker: één speler (eigen gebruik), Engelstalige D4-client, borderless/windowed, Windows 10/11.

### User stories
1. Ik open de app, plak een Maxroll-link en de build staat binnen ~10 s klaar in de overlay.
2. Ik kies build en fase (Leveling, Starter, Endgame…) uit een dropdown; de keuze blijft bewaard.
3. Ik hover een item en zie meteen of het past, en of het beter is dan wat ik draag.
4. Ik zie per slot wat ik nodig heb (item/aspect, affixes, temper, gems/runes) en mijn totale voortgang.
5. Ik zie mijn skill bar en welke skill-tree-nodes ik moet nemen, voor leveling in de juiste volgorde.
6. Ik zie per paragon board welke nodes ik moet nemen, welke glyph erin hoort en hoe het board gedraaid staat.
7. Ik verplaats, schaal en verberg de overlay; alles wordt onthouden.

## Capability map

| Module id | Verantwoordelijkheid | Hangt af van |
|---|---|---|
| `build-import` | Link → Maxroll-profiel + speldata (cache) → genormaliseerde build (gear, skills, paragon, overig) | — |
| `build-library` | Builds opslaan/kiezen/verwijderen, actieve build + fase, voortgang per build | build-import |
| `gear-tracker` | Scherm-OCR → tooltip → vergelijking → voortgang (bestaat al) | build-library |
| `overlay-ui` | Overlayvenster: tabs Gear / Skills / Paragon, live tooltip-kaart, detailweergave | build-library, gear-tracker |
| `app-shell` | Beheervenster (link plakken, builds, instellingen), tray-icoon, sneltoetsen, opslag in `%APPDATA%` | alle |
| `packaging` | electron-builder NSIS-installer, icoon, `ocr.ps1` meeleveren | app-shell |

Bouwvolgorde: build-import → build-library → overlay-ui (skills, paragon) → app-shell → packaging.
gear-tracker wordt alleen aangepast waar nodig.

## Wat de build bevat (uit Maxroll-planner, per fase)
- **Gear**: per slot item/unique, aspect, affixes (+greater), tempering, sockets (gems/runes) — al aanwezig.
- **Skills**: skill bar (6), skill-tree-nodes met rank, gegroepeerd (actief / upgrade / passive / key passive);
  bij meerdere stappen (leveling) de volgorde per stap. Klassemechaniek waar aanwezig (bijv. Barbarian
  arsenal + weapon expertise).
- **Paragon**: stappen → boards in volgorde, per board: naam, rotatie, glyph + level, 21×21 raster met
  nodetype (normal/magic/rare/legendary/gate/glyph socket) en gekozen nodes; namen van rare/legendary nodes.
- **Overig**: mercenary (+ support), renown-info.

## Niet in scope (v1)
- Teksten/uitleg uit guide-artikelen en planner-notities (auteursrecht Maxroll).
- Iconen/afbeeldingen van Blizzard of Maxroll; alles wordt zelf getekend.
- Andere sites dan Maxroll (de importer krijgt wel een bron-interface zodat dit later kan).
- Auto-update, code signing, niet-Engelse game-client, D4 op een tweede monitor, exclusive fullscreen.

## Tech Stack
Electron 33.2.1, Node 24 (ESM `.mjs`), plain HTML/CSS/JS in de renderer (geen framework), Windows.Media.Ocr
via `ocr.ps1`, electron-builder voor de installer. Geen extra runtime-dependencies.

## Commands
```
npm start                     # app starten (dev)
npm start -- --image <file>   # overlay testen met een screenshot
npm test                      # node --test
npm run import -- <link> out.json   # CLI-import (blijft bestaan)
npm run dist                  # installer bouwen → dist/D4 Build Tracker Setup x.y.z.exe
```

## Project Structure
```
main.mjs            app-shell: vensters, tray, sneltoetsen, IPC, capture-loop
importer.mjs        build-import (Maxroll → genormaliseerde build)
tracker.mjs         gear-tracker (tooltip-parser, vergelijking, voortgang)
library.mjs         build-library (opslag in userData)
ocr.ps1             OCR-server (extraResources)
overlay.html        overlay-renderer (tabs Gear/Skills/Paragon)
control.html        beheervenster (link plakken, builds, instellingen)
preload.cjs         IPC-bridge
*.test.mjs          tests naast de code
samples/            OCR-regressiescreenshots
docs/               onderzoek
```

## Code Style
Bestaande stijl aanhouden: ESM, kleine pure functies, commentaar alleen voor het "waarom", geen frameworks.
```js
// a unique's affixes are fixed and Maxroll sometimes lists ones the game version lacks, so the name decides
const score = s.unique ? (item ? 100 : 0) : total ? Math.round((got / total) * 100) : 0;
```

## Testing Strategy
- `node:test` unit tests voor importer (skills, paragon, gear), library en tracker.
- Regressie: alle screenshots in `samples/` moeten hun huidige uitkomst houden.
- Overlay-UI: handmatig + gesimuleerde muis (`--image`-modus), screenshot-controle.
- Packaging: installer bouwen, installeren in een schone map, app start en importeert een link.

## Boundaries
- **Altijd**: tests draaien voor oplevering; `progress.json`/builds back-uppen voor UI-tests; alleen
  `https://maxroll.gg/d4/...`-links of planner-ID's accepteren; geïmporteerde data als data behandelen.
- **Eerst vragen**: nieuwe dependencies buiten electron-builder; andere bronnen dan Maxroll; iets publiceren.
- **Nooit**: code of HTML uit geïmporteerde data uitvoeren of als HTML renderen; injectie in het gameproces;
  game-input automatiseren.

## Success Criteria
1. `dist/*.exe` installeert; de app start zonder Node/npm op het systeem.
2. Link plakken → build met alle fases binnen 10 s (eerste keer incl. speldata), daarna ook offline bruikbaar.
3. Overlay-tab **Skills** toont de skill bar en alle gekozen nodes met rank voor elke fase van de testbuild.
4. Overlay-tab **Paragon** toont elk board van de gekozen fase met juiste rotatie, glyph en gekozen nodes.
5. Gear-tracker: alle bestaande screenshot-regressies blijven gelijk; tests slagen.
6. Overlay blijft verplaatsbaar/schaalbaar/verbergbaar, geen muis-hapering, instellingen blijven bewaard.
7. Bestaande build + voortgang worden bij de eerste start overgenomen.

## Besluiten (goedgekeurd 2026-10-30)
1. Paragon: compact board per tab + grote detailweergave met alle boards (sneltoets, midden in beeld).
2. Sneltoetsen: `Alt+Shift+O` overlay aan/uit, `Alt+Shift+B` detailweergave; aan te passen in het beheervenster.
3. NSIS-installer met startmenu- en bureaubladsnelkoppeling.
4. Rotatie van paragon-boards is met de klok mee (gecontroleerd: alle 172 boards in de testbuild sluiten aan).
