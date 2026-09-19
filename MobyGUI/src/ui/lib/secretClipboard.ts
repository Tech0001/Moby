// Desktop handles expiry even if the renderer is suspended or navigated away.
// Web fallback is best effort: browser permissions may prevent reading/clearing.
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
export async function copyWalletSecret(text: string): Promise<void> {
  if (window.electronAPI?.copyWalletSecret) {
    await window.electronAPI.copyWalletSecret(text);
    return;
  }
  const current = ++generation;
  await navigator.clipboard.writeText(text);
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    try {
      if (current === generation && await navigator.clipboard.readText() === text && current === generation) {
        await navigator.clipboard.writeText('');
      }
    } catch { /* Clipboard history and browser permissions cannot be controlled here. */ }
  }, 30_000);
}
