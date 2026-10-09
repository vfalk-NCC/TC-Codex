# TC Codex · Modellstudio

An external 3D workspace launched from a Trimble Connect project extension. The first increment provides the studio shell, local IFC parsing/rendering through IFClite, a DXF drawing preview, and the Connect extension entry panel.

## Run locally

```sh
corepack pnpm install
corepack pnpm dev
```

Open `http://localhost:5173/#/editor` for the editor or `http://localhost:5173/#/trimble` for the Trimble Connect launch panel. IFC rendering uses WebGPU; DXF preview currently draws LINE, LWPOLYLINE and CIRCLE entities. Point-cloud file selection is present, while decoding and rendering are a later increment.

## Trimble Connect extension

`public/manifest.json` describes a project extension. Host the built app at the URL in the manifest, then add the manifest URL in Trimble Connect under **Project Settings → Apps & Capabilities → Add Custom**. Project administrators can add custom extensions. The extension obtains its Connect session from the Workspace API and passes the project context to the separate editor tab using same-origin `postMessage`; access tokens are kept in memory and are not put in URLs or local storage.

The Core API file browser and upload/download operations are not connected yet. They require the correct project region, endpoints, user permission, and API registration. Do not add client secrets to this frontend. Once those are configured, the file dialog can be wired to the Core API for listing folders and transferring IFC/DXF files.

The current manifest uses GitHub Pages at `vfalk-ncc.github.io/TC-Codex`. GitHub Pages must be enabled for the repository and the production URL must remain CORS-readable by Trimble Connect.
