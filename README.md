# Moby

Moby is a self-hosted daemon with an Electron shell that monitors exchange activity and auto-withdraws funds based on your configuration.

## Configuration and data paths

- **Config**: persisted in the app database (no config.yaml). On first run, defaults are written into the DB. A legacy `config.yaml` will be migrated into the DB once if present.
- **Encryption key**: stored in `.env` inside the app data directory. This holds `MOBY_ENCRYPTION_KEY`, which is required to decrypt stored API keys. Back it up. You can override the path with `ENV_FILE_PATH` if needed.
- **Database**: stored as `moby.db` in the app data directory by default. Override with `DB_PATH`.
- **App data directory**: defaults to `MOBY_DATA_PATH` if set; otherwise Electron’s `app.getPath('userData')` (e.g., `~/Library/Application Support/Moby` on macOS) or `DATA_DIR`/current working directory in non-Electron environments.

## Scripts (development)

- `npm run dev` — run the server in watch mode.
- `npm run dev:ui` — run the Vite UI in dev mode.
- `npm run build` — build server and UI.
- `npm run electron:dev` — build and run Electron locally.
- `npm run electron:build:mac` — build a macOS app bundle.



 1. For x64 build (under Rosetta):

     rm -rf node_modules
     arch -x86_64 npm ci
     arch -x86_64 npm run build
     arch -x86_64 npm run electron:build:mac -- --x64
     Grab release/Moby-<version>-x64.dmg.
  2. To go back to Apple Silicon builds:

     rm -rf node_modules
     npm ci
     npm run build
     npm run electron:build:mac -- --arm64
     Grab the arm64 dmg.