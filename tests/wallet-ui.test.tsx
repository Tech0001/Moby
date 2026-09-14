// @vitest-environment jsdom
import { it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup, within } from '@testing-library/react';
import { ManagementPanel } from '../src/ui/components/ManagementPanel';
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const wallets = [
  { id: 'A', name: 'Wallet A', chain: 'ethereum', address: 'TEST-A', createdAt: 1 },
  { id: 'B', name: 'Wallet B', chain: 'ethereum', address: 'TEST-B', createdAt: 2 },
];
const secrets = { id: 'A', address: 'TEST-A', chain: 'ethereum', privateKey: 'FAKE_KEY_A', mnemonic: 'not real recovery words' };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function setup(unlock = async () => json(secrets)) {
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/wallets/password/exists') return json({ exists: true });
    if (url === '/api/wallets') return json({ wallets });
    if (url.endsWith('/unlock')) return unlock();
    if (options?.method === 'DELETE') return json({ success: true });
    throw new Error('Unexpected test request');
  });
  vi.stubGlobal('fetch', fetcher); const view = render(<ManagementPanel />); await screen.findByText('Wallet A');
  return { fetcher, ...view };
}
function open(id = 'A') {
  fireEvent.click(within(screen.getByText(`Wallet ${id}`).closest('tr')!).getByTitle('View Private Key'));
}
function unlock() {
  fireEvent.change(screen.getByPlaceholderText('Enter your wallet password'), { target: { value: 'disposable-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Unlock', exact: true }));
}
it('discards a late unlock after closing wallet A and opening wallet B, even if abort is ignored', async () => {
  let respond!: (value: Response) => void;
  const pending = new Promise<Response>(resolve => { respond = resolve; });
  const { fetcher } = await setup(() => pending);
  open(); unlock();
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url === '/api/wallets/A/unlock')).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); open('B');
  await act(async () => { respond(json(secrets)); });
  expect(screen.queryByText('Seed Phrase')).toBeNull();
  expect(screen.getByPlaceholderText('Enter your wallet password')).toBeTruthy();
  expect(within(screen.getByRole('dialog')).getByText('TEST-B')).toBeTruthy();
  expect(fetcher.mock.calls.some(([url]) => url === '/api/wallets/B/unlock')).toBe(false);
});
it.each(['blur', 'moby:vault-lock'])('clears unlocked secrets and rejects late responses on %s', async event => {
  await setup(); open(); unlock(); await screen.findByRole('button', { name: 'Seed Phrase', exact: true });
  act(() => window.dispatchEvent(new Event(event)));
  expect(screen.queryByRole('dialog')).toBeNull();
  open(); expect(screen.getByPlaceholderText('Enter your wallet password')).toHaveProperty('value', '');
  expect(screen.queryByRole('button', { name: 'Seed Phrase', exact: true })).toBeNull();
});
it('closes secrets after 60 seconds without interaction', async () => {
  await setup(); open(); unlock(); await screen.findByRole('button', { name: 'Seed Phrase', exact: true });
  vi.useFakeTimers(); fireEvent.keyDown(window, { key: 'Shift' });
  act(() => vi.advanceTimersByTime(59_000)); expect(screen.getByRole('dialog')).toBeTruthy();
  act(() => vi.advanceTimersByTime(1000)); expect(screen.queryByRole('dialog')).toBeNull();
});
it('rejects a response with mismatched wallet identity', async () => {
  await setup(async () => json({ ...secrets, address: 'SOMEWHERE-ELSE' })); open(); unlock();
  await screen.findAllByText('Wallet response did not match the selected wallet. Refresh and try again.');
  expect(screen.queryByRole('button', { name: 'Seed Phrase', exact: true })).toBeNull();
});
it('requires the password and recovery confirmation for the displayed deletion target', async () => {
  const { fetcher } = await setup();
  fireEvent.click(within(screen.getByText('Wallet A').closest('tr')!).getByTitle('Delete Wallet'));
  const dialog = within(screen.getByRole('dialog')), button = dialog.getByRole('button', { name: 'Delete Wallet' });
  expect(button).toHaveProperty('disabled', true);
  fireEvent.change(dialog.getByLabelText('Wallet Password'), { target: { value: 'disposable-password' } });
  expect(button).toHaveProperty('disabled', true);
  fireEvent.click(dialog.getByRole('checkbox')); expect(button).toHaveProperty('disabled', false);
  fireEvent.click(button);
  await waitFor(() => expect(fetcher.mock.calls.some(([url, options]) => url === '/api/wallets/A' && options?.method === 'DELETE')).toBe(true));
  const body = fetcher.mock.calls.find(([url]) => url === '/api/wallets/A')![1]!.body as string;
  expect(JSON.parse(body)).toEqual({ password: 'disposable-password', backupConfirmed: true, address: 'TEST-A' });
  await waitFor(() => expect(screen.queryByText('Wallet A')).toBeNull());
});
it('clears an unfinished creation password when the dialog is cancelled', async () => {
  await setup(); fireEvent.click(screen.getByRole('button', { name: 'Generate Wallet', exact: true }));
  const input = screen.getByPlaceholderText('Enter master password to encrypt');
  fireEvent.change(input, { target: { value: 'disposable-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Generate Wallet', exact: true }));
  expect(screen.getByPlaceholderText('Enter master password to encrypt')).toHaveProperty('value', '');
});
