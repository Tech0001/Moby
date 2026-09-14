const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  copyWalletSecret: (text) => ipcRenderer.invoke('copy-wallet-secret', text),

  // Platform info
  platform: process.platform,

  // App version
  getVersion: () => ipcRenderer.invoke('get-version'),

  // Notifications
  showNotification: (title, body) => {
    ipcRenderer.send('show-notification', { title, body });
  },

  // Window controls
  minimizeToTray: () => ipcRenderer.send('minimize-to-tray'),
  quit: () => ipcRenderer.send('quit-app'),

  // Check if running in Electron
  isElectron: true,
});

// Log that preload script ran
console.log('Moby preload script loaded');

ipcRenderer.on('vault-lock', () => window.dispatchEvent(new Event('moby:vault-lock')));
