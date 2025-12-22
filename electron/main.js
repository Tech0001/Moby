import { app, BrowserWindow, powerMonitor, shell, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure production defaults for packaged builds (important for server logging behavior)
if (app.isPackaged) {
  process.env.NODE_ENV ||= 'production';
}

// Keep references to prevent garbage collection
let mainWindow = null;
let serverProcess = null;
let serverStarted = false;

const SERVER_PORT = 3000;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;

// Set userData path for the app data (db, config, logs)
const userDataPath = app.getPath('userData');
process.env.MOBY_DATA_PATH = userDataPath;

// Simple file logger for Electron main process debugging
function electronLog(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ELECTRON: ${msg}\n`;
  try {
    // Ensure directory exists
    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath, { recursive: true });
    }
    fs.appendFileSync(path.join(userDataPath, 'moby.log'), line);
  } catch (err) {
    // Log to console as fallback
    console.error(`electronLog failed: ${err.message}, path: ${userDataPath}`);
  }
}

// Log the userData path on startup for debugging
console.log(`Moby userData path: ${userDataPath}`);

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
      // Ensure timers are throttled when the window is hidden/minimized.
      backgroundThrottling: true,
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
 * Start the Express server in-process
 */
async function startServer() {
  electronLog('startServer called');
  const serverPath = path.join(__dirname, '..', 'dist', 'server', 'app.js');

  // Check if compiled server exists
  try {
    fs.accessSync(serverPath);
    electronLog(`Server file found: ${serverPath}`);
  } catch {
    electronLog('Server file not found, checking dev mode');
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
  electronLog('Importing server module');
  const serverUrl = `file://${serverPath}`;
  await import(serverUrl);
  electronLog('Server module imported');

  // Wait for the server to actually be reachable, otherwise Electron init appears to "hang"
  electronLog('Waiting for server to be ready');
  await waitForServerReady(30_000);
  electronLog('Server is ready');
  serverStarted = true;
}

async function waitForServerReady(timeoutMs) {
  const start = Date.now();
  const statusUrl = `${SERVER_URL}/api/setup/status`;

  while (Date.now() - start < timeoutMs) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(statusUrl, { signal: controller.signal });
      clearTimeout(timer);

      if (res.ok) return;
    } catch {
      // ignore until timeout
    }

    await new Promise((r) => setTimeout(r, 250));
  }

  throw new Error(`Server did not become ready within ${Math.round(timeoutMs / 1000)}s (${statusUrl})`);
}

// Keep process alive - Electron sometimes quits if it thinks there's nothing to do
setInterval(() => {}, 1000 * 60 * 60);

/**
 * Stop the server - handles both subprocess (dev) and in-process (production) modes
 */
function stopServer() {
  if (serverProcess) {
    // Dev mode: kill the subprocess
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  } else if (serverStarted) {
    // Production mode: server runs in-process, trigger shutdown via signal event
    // The server's app.ts listens for SIGTERM/SIGINT and runs shutdown()
    process.emit('SIGTERM');
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
  electronLog('initialize called');

  // Create data directory if it doesn't exist
  if (!fs.existsSync(userDataPath)) {
    fs.mkdirSync(userDataPath, { recursive: true });
  }

  try {
    await startServer();
    electronLog('Server started, creating window');
    createWindow();
    setupPowerMonitor();
    electronLog('Initialization complete');
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

// App ready
app.whenReady().then(initialize);

// Quit when all windows are closed
app.on('window-all-closed', () => {
  electronLog('window-all-closed event');
  app.quit();
});

app.on('activate', () => {
  electronLog('activate event');
  // On macOS, re-create window when dock icon is clicked
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

// Clean up before quitting
app.on('before-quit', () => {
  electronLog('before-quit event');
  stopServer();
});

// Handle second instance (single instance lock)
const gotTheLock = app.requestSingleInstanceLock();
electronLog(`Single instance lock: ${gotTheLock ? 'obtained' : 'failed (another instance running)'}`);

if (!gotTheLock) {
  electronLog('Quitting because another instance is running');
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
