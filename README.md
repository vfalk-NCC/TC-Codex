# TC Codex · 4D-light

Trimble Connect-extension som kopplar modellens objekt till en tidplan och spelar upp bygget i 3D-vyn. Byggd med Vite, React och TypeScript.

## Funktioner

- **Skapa från modell** – en aktivitet per värde på en vald egenskap (t.ex. våning), per IFC-klass, eller per höjdnivå nedifrån och upp.
- **WBS-områden** – skapa egna områden (t.ex. "741 - Sektionsfickor") och dra aktiviteter mellan dem. Dra till en annan aktivitet för att ändra ordning.
- **Koppla för hand** – markera objekt i 3D-vyn och koppla dem till en aktivitet.
- **Uppspelning** – tidslinje med uppspelning och stegning. Ej påbörjat döljs, pågående färgas, färdigt visas i modellens egna färger. Aktivitetstyperna Bygg, Riv och Tillfällig styr vad som händer före och efter.
- **Importera datum** – rader med `namn;start;slut;område` (området är valfritt; klistra in från Excel eller välj CSV) uppdaterar aktiviteter med samma namn.
- **Lösenord** – appen frågar efter ett lösenord en gång per webbläsarsession. Det håller bara tillfälliga besökare ute; sidan är publik och koden kan läsas av vem som helst.
- **Spara** – planen sparas i webbläsaren per projekt och kan exporteras/öppnas som JSON. Objekt sparas med IFC-GUID så att kopplingarna överlever nya modellversioner.

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
- `src/App.tsx` – gränssnittet.

## Trimble Connect

`public/manifest.json` publiceras på `https://vfalk-ncc.github.io/TC-Codex/manifest.json` och pekar på `#/trimble`. Manifestets sökväg, `icon.svg` och bas-sökvägen `/TC-Codex/` i `vite.config.ts` måste ligga kvar för att extensionen ska fortsätta fungera i projekt där den redan är tillagd.

Push till `main` bygger och publicerar till GitHub Pages via `.github/workflows/deploy-pages.yml`.
