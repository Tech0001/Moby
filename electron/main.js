import { app, BrowserWindow, Tray, Menu, nativeImage, powerMonitor, shell, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Keep references to prevent garbage collection
let mainWindow = null;
let tray = null;
let serverProcess = null;
let isQuitting = false;

const SERVER_PORT = 3000;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;

// Set userData path for the app data (db, config, logs)
const userDataPath = app.getPath('userData');
process.env.MOBY_DATA_PATH = userDataPath;

/**
 * Create the main application window
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false, // Don't show until ready
    titleBarStyle: 'default',
  });

  // Show window when ready to prevent visual flash
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Load the server URL
  mainWindow.loadURL(SERVER_URL);

  // Handle window close - minimize to tray instead of quitting
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

/**
 * Get the appropriate icon path for the current platform
 */
function getIconPath() {
  const iconName = process.platform === 'win32' ? 'icon.ico' :
                   process.platform === 'darwin' ? 'icon.icns' : 'icon.png';

  // In development, use assets folder. In production, use resources.
  const devPath = path.join(__dirname, '..', 'assets', iconName);
  const prodPath = path.join(process.resourcesPath, 'assets', iconName);

  try {
    fs.accessSync(devPath);
    return devPath;
  } catch {
    return prodPath;
  }
}

/**
 * Create the system tray icon and menu
 */
function createTray() {
  const trayIconPath = path.join(__dirname, '..', 'assets', 'icon.png');

  // Create a smaller icon for the tray (16x16 or 22x22)
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(trayIconPath);
    // Resize for tray
    trayIcon = trayIcon.resize({ width: 16, height: 16 });
  } catch {
    // Use a default empty icon if not found
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('Moby - Crypto Auto-Sweeper');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Moby',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Moby',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  // Click on tray icon to show/hide window
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
}

/**
 * Start the Express server in-process
 */
async function startServer() {
  const serverPath = path.join(__dirname, '..', 'dist', 'server', 'app.js');

  // Check if compiled server exists
  try {
    fs.accessSync(serverPath);
  } catch {
    if (!app.isPackaged) {
      // Fall back to tsx for development only
      const { spawn } = await import('child_process');
      const sourcePath = path.join(__dirname, '..', 'src', 'server', 'app.ts');

      return new Promise((resolve, reject) => {
        serverProcess = spawn('npx', ['tsx', sourcePath], {
          cwd: path.join(__dirname, '..'),
          env: { ...process.env, MOBY_DATA_PATH: userDataPath },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        serverProcess.stdout.on('data', (data) => {
          if (data.toString().includes('Web server started')) resolve();
        });
        serverProcess.on('error', reject);

        setTimeout(resolve, 30000);
      });
    } else {
      throw new Error(`Server file not found: ${serverPath}`);
    }
  }

  // Import the compiled server directly (runs in same process)
  const serverUrl = `file://${serverPath}`;
  await import(serverUrl);

  // Give it a moment to start listening
  await new Promise(resolve => setTimeout(resolve, 1000));
}

// Keep process alive - Electron sometimes quits if it thinks there's nothing to do
setInterval(() => {}, 1000 * 60 * 60);

/**
 * Stop the server process (only used in dev mode with subprocess)
 */
function stopServer() {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}

/**
 * Set up power monitor events
 */
function setupPowerMonitor() {
  powerMonitor.on('lock-screen', () => {});
  powerMonitor.on('unlock-screen', () => {});
  powerMonitor.on('suspend', () => {});
  powerMonitor.on('resume', () => {});
}

/**
 * Initialize the application
 */
async function initialize() {
  // Create data directory if it doesn't exist
  if (!fs.existsSync(userDataPath)) {
    fs.mkdirSync(userDataPath, { recursive: true });
  }

  try {
    await startServer();
    createWindow();
    createTray();
    setupPowerMonitor();
  } catch (err) {
    try {
      const message = err instanceof Error ? `${err.message}\n${err.stack || ''}` : String(err);
      const logPath = path.join(userDataPath, 'startup-error.log');
      fs.writeFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, { flag: 'a' });
      // eslint-disable-next-line no-console
      console.error('Fatal startup error:', message);
      dialog.showErrorBox('Moby failed to start', `A fatal startup error occurred.\n\n${message}\n\nDetails saved to:\n${logPath}`);
    } catch {
      // ignore secondary logging failures
    }
    app.quit();
  }
}

// Prevent app from quitting unexpectedly
app.on('will-quit', (event) => {
  if (!isQuitting) {
    event.preventDefault();
  }
});

// App ready
app.whenReady().then(initialize);

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  // On macOS, keep the app running in the tray
  if (process.platform !== 'darwin') {
    // On Windows/Linux, app stays in tray
  }
});

app.on('activate', () => {
  // On macOS, re-create window when dock icon is clicked
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

// Clean up before quitting
app.on('before-quit', () => {
  isQuitting = true;
  stopServer();
});

// Handle second instance (single instance lock)
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
