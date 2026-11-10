# TC Codex

Trimble Connect-extension byggd med Vite, React och TypeScript.

## Köra lokalt

```sh
corepack pnpm install
corepack pnpm dev
```

## Trimble Connect

`public/manifest.json` publiceras på `https://vfalk-ncc.github.io/TC-Codex/manifest.json` och pekar på `#/trimble`. Manifestets sökväg, `icon.svg` och bas-sökvägen `/TC-Codex/` i `vite.config.ts` måste ligga kvar för att extensionen ska fortsätta fungera i projekt där den redan är tillagd.

Push till `main` bygger och publicerar till GitHub Pages via `.github/workflows/deploy-pages.yml`.
