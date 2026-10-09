# TC Codex · Modellstudio

An external 3D workspace launched from a Trimble Connect project or 3D Viewer extension. It provides local IFC/DXF workflows, point-cloud viewing, and a Connect file browser for importing and uploading supported model files.

## Run locally

```sh
corepack pnpm install
corepack pnpm dev
```

Open `http://localhost:5173/#/editor` for the editor or `http://localhost:5173/#/trimble` for the Trimble Connect launch panel. IFC rendering uses WebGPU; DXF preview currently draws LINE, LWPOLYLINE and CIRCLE entities. Point clouds are decoded and rendered with IFClite, with sampling for large files.

## Trimble Connect extension

`public/manifest.json` describes an extension for both the project UI and the 3D Viewer. Host the built app at the URL in the manifest, then add the manifest URL in each Trimble Connect project where it should be available under **Project Settings → Apps & Capabilities → Add Custom**. Project administrators can add custom extensions. The extension obtains its Connect session from the Workspace API and passes the project context to the separate editor tab using same-origin `postMessage`; access tokens are kept in memory and are not put in URLs or local storage. If a manifest changes after an extension was added, re-add or refresh that project capability so Connect reads the current extension type.

The Connect file browser uses the project session and regional Core API endpoints for folder listing and file transfer. Runtime access depends on the extension being launched from a project where it is enabled and on the signed-in user's permissions. Core API operations may additionally require application registration. Do not add client secrets to this frontend.

The current manifest uses GitHub Pages at `vfalk-ncc.github.io/TC-Codex`. GitHub Pages must be enabled for the repository and the production URL must remain readable by Trimble Connect.
