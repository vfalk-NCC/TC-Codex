# TC Codex · 4D-light

Trimble Connect-extension som kopplar modellens objekt till en tidplan och spelar upp bygget i 3D-vyn. Byggd med Vite, React och TypeScript.

## Funktioner

**Planera**
- **Skapa från modell** – en aktivitet per värde på en vald egenskap (t.ex. våning), per IFC-klass, eller per höjdnivå nedifrån och upp.
- **Koppla för hand** – markera objekt i 3D-vyn och koppla dem till en aktivitet.
- **WBS-områden** – egna områden (t.ex. "741 - Sektionsfickor"); dra aktiviteter mellan dem eller till en annan aktivitet för att ändra ordning.
- **Gantt i listan** – dra en stapel för att flytta aktiviteten i tiden, dra i ändarna för att ändra start eller slut. Tidsaxel med veckonummer och markering för idag.
- **Milstolpar** – daterade hållpunkter (t.ex. "Tätt hus") som visas som diamanter på tidslinjen, med nedräkning till nästa.
- **Projektöversikt** – hela projektet från första start till sista slut på en rad, med områden, milstolpar och idag; dra i den för att flytta datumet.
- **Ångra / gör om** (Ctrl+Z / Ctrl+Y), duplicera aktivitet, sök, förskjut hela planen eller ett område ett antal dagar.
- **Import och export** – rader med `namn;start;slut;område` från Excel/CSV, export till CSV, och hela planen som JSON.

**Visualisera**
- **Tidplan** – tidslinje med uppspelning, stegning dag för dag och hopp mellan händelser. Ej påbörjat döljs, pågående färgas, färdigt visas i modellens egna färger. Typerna Bygg, Riv och Tillfällig styr vad som händer före och efter.
- **Status** – färgar modellen efter rapporterad status: ej påbörjad, pågår, klar och försenad.
- **Släck** – dölj eller gör objekt genomskinliga oavsett tidplan, t.ex. bjälklag eller fasadelement som skymmer. "Släck liknande" hittar alla objekt med samma egenskap som det markerade.
- **Hitta** – markera ett objekt i modellen för att se vilken aktivitet det tillhör; zooma till en aktivitets objekt; markera objekt som saknar aktivitet.

**Övrigt**
- **Tema** – mörkt eller ljust, växlas med sol/måne-knappen och sparas i webbläsaren.
- **Lösenord** – appen frågar efter ett lösenord en gång per webbläsarsession. Det håller bara tillfälliga besökare ute; sidan är publik och koden kan läsas av vem som helst.
- **Spara** – planen sparas i webbläsaren per projekt. Objekt sparas med IFC-GUID så att kopplingarna överlever nya modellversioner.
- **Prestanda** – modellen uppdateras bara för de aktiviteter vars utseende ändras, så att antalet anrop till 3D-vyn hålls nere.

## Köra lokalt

```sh
corepack pnpm install
corepack pnpm dev
```

Utanför Trimble Connect startar appen i demoläge med en inbyggd exempelmodell.

## Kod

- `src/viewer.ts` – gränssnittet mot 3D-vyn (`ViewerPort`) och kopplingen till Trimble Connect Workspace API.
- `src/demo.ts`, `src/DemoScene.tsx` – demovyn.
- `src/schedule.ts` – tidplan, färgläggning, generering, import och lagring.
- `src/App.tsx`, `src/parts.tsx` – gränssnittet och dialogerna.

## Trimble Connect

`public/manifest.json` publiceras på `https://vfalk-ncc.github.io/TC-Codex/manifest.json` och pekar på `#/trimble`. Manifestets sökväg, `icon.svg` och bas-sökvägen `/TC-Codex/` i `vite.config.ts` måste ligga kvar för att extensionen ska fortsätta fungera i projekt där den redan är tillagd.

Push till `main` bygger och publicerar till GitHub Pages via `.github/workflows/deploy-pages.yml`.
