# Moby Desktop Application (Electron)

## Goal
Package Moby as a desktop application that non-technical users can easily install and run, with background daemon operation that continues when the screen locks.

---

## Why Electron

| Consideration | Electron | Tauri | pkg |
|--------------|----------|-------|-----|
| Node.js backend compatibility | Native | Subprocess needed | Good |
| Native modules (better-sqlite3) | Excellent | Difficult | Good |
| System tray | Native | Native | 3rd party |
| Background running | Excellent | Excellent | Difficult |
| Installation UX | DMG/NSIS | DMG/NSIS | Raw binary |
| Auto-updates | Built-in | Good | Manual |
| Bundle size | ~180MB | ~80MB* | ~100MB |

*Tauri with Node.js subprocess negates size benefits

**Verdict**: Electron is the best fit - Node.js backend works natively, native modules compile cleanly, and installation experience is exactly what non-technical users expect.

---

## Architecture

```
Moby.app / Moby.exe
├── main.js              (Electron main process)
│   ├── Starts Express server
│   ├── Creates BrowserWindow (loads localhost:3000)
│   ├── Manages system tray icon
│   ├── Handles power events (screen lock vs sleep)
│   └── Keeps daemon alive when window closes
├── preload.js           (IPC bridge to renderer)
├── dist/                (compiled React UI)
├── dist/server/         (compiled Express server)
├── node_modules/        (including native modules)
└── data/                (SQLite db, configs - in user app data)
```

---

## Implementation Plan

### 1. Install Electron Dependencies
```bash
npm install --save-dev electron electron-builder electron-rebuild
```

### 2. Create Electron Main Process
**New file**: `electron/main.js`

- Start Express server on app launch
- Create BrowserWindow pointing to `http://localhost:3000`
- Create system tray with menu (Show/Hide, Quit)
- Keep app running when window closes (minimize to tray)
- Handle `powerMonitor` events for screen lock/unlock

### 3. Create Preload Script
**New file**: `electron/preload.js`

- Expose safe IPC methods to renderer if needed
- Handle native dialogs, notifications

### 4. Update Data Paths
**Modify**: Server code to use `app.getPath('userData')` for:
- SQLite database
- Config files
- Logs

### 5. Configure electron-builder
**New file**: `electron-builder.yml` or in `package.json`

```yaml
appId: com.moby.app
productName: Moby
directories:
  output: release
files:
  - dist/**/*
  - electron/**/*
  - node_modules/**/*
  - package.json
mac:
  category: public.app-category.finance
  target:
    - dmg
    - zip
  icon: assets/icon.icns
win:
  target:
    - nsis
    - portable
  icon: assets/icon.ico
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
```

### 6. Update package.json Scripts
```json
{
  "main": "electron/main.js",
  "scripts": {
    "electron:dev": "electron .",
    "electron:build": "npm run build && electron-builder",
    "postinstall": "electron-rebuild"
  }
}
```

### 7. Create App Icons
**New files**:
- `assets/icon.icns` (macOS)
- `assets/icon.ico` (Windows)
- `assets/icon.png` (Linux/tray)

---

## Key Features

### System Tray
- App minimizes to tray instead of quitting
- Tray menu: Show Window, Separator, Quit
- Click tray icon to show/hide window
- Badge/notification for withdrawal events

### Background Running
- Daemon continues when window closed
- Continues when screen locks
- Respects system sleep (pauses gracefully)
- Auto-start on login: **Optional setting (off by default)**

### Data Location
- macOS: `~/Library/Application Support/Moby/`
- Windows: `%APPDATA%/Moby/`
- Linux: `~/.config/Moby/`

---

## File Changes Summary

| File | Action |
|------|--------|
| `electron/main.js` | CREATE - Main process |
| `electron/preload.js` | CREATE - IPC bridge |
| `electron-builder.yml` | CREATE - Build config |
| `package.json` | MODIFY - Add electron deps/scripts |
| `src/server/db/sqlite.ts` | MODIFY - Dynamic data path |
| `assets/icon.*` | CREATE - App icons |

---

## Expected Outputs

| Platform | Installer | Size |
|----------|-----------|------|
| macOS | `Moby-1.0.0.dmg` | ~180MB |
| Windows | `Moby Setup 1.0.0.exe` | ~200MB |
| Linux | `Moby-1.0.0.AppImage` | ~170MB |

---

## User Experience

### Installation (macOS)
1. Download `Moby.dmg`
2. Drag Moby to Applications
3. Launch Moby
4. App appears in menu bar tray

### Installation (Windows)
1. Download `Moby Setup.exe`
2. Run installer
3. Launch from Start Menu
4. App appears in system tray

### Daily Use
- App runs in background (tray icon)
- Click tray to open dashboard
- Close window = minimize to tray (daemon keeps running)
- Quit from tray menu to fully stop
