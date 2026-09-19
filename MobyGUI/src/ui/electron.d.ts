export {};
declare global {
  interface Window {
    electronAPI?: { isElectron: boolean; copyWalletSecret: (text: string) => Promise<void> };
  }
}
