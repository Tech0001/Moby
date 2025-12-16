# Moby

Moby is a self-hosted daemon with an Electron shell that monitors exchange activity and auto-withdraws funds based on your configuration.

## Configuration and data paths

- **Config file**: defaults to `config.yaml` inside the app data directory. On macOS packaged builds this is `~/Library/Application Support/Moby/config.yaml`. Override with `CONFIG_PATH` if you want a custom location.
- **Encryption key**: stored in `.env` inside the app data directory. This holds `MOBY_ENCRYPTION_KEY`, which is required to decrypt stored API keys. Back it up. You can override the path with `ENV_FILE_PATH` if needed.
- **Database**: stored as `moby.db` in the app data directory by default. Override with `DB_PATH`.
- **App data directory**: defaults to `MOBY_DATA_PATH` if set; otherwise Electron’s `app.getPath('userData')` (e.g., `~/Library/Application Support/Moby` on macOS) or `DATA_DIR`/current working directory in non-Electron environments.

## Scripts (development)

- `npm run dev` — run the server in watch mode.
- `npm run dev:ui` — run the Vite UI in dev mode.
- `npm run build` — build server and UI.
- `npm run electron:dev` — build and run Electron locally.
- `npm run electron:build:mac` — build a macOS app bundle.
