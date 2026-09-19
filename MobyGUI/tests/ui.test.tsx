// @vitest-environment jsdom
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { StrictMode } from 'react';
import { OrdersPanel } from '../src/ui/components/OrdersPanel';
import { Dashboard } from '../src/ui/components/Dashboard';
import { App } from '../src/ui/App';
import { apiFetch, SESSION_EXPIRED } from '../src/ui/lib/api';

vi.mock('../src/ui/components/ThemeProvider', () => ({ useTheme: () => ({ style: 'default', setStyle: () => {} }) }));
vi.mock('../src/ui/components/BalancePanel', () => ({ BalancePanel: () => null }));
vi.mock('../src/ui/components/SetupGuide', () => ({ SetupGuide: () => null }));
vi.mock('../src/ui/components/ModeToggle', () => ({ ModeToggle: () => null }));
vi.mock('../src/ui/components/ThemeSelector', () => ({ ThemeSelector: () => null }));
vi.mock('../src/ui/components/Login', () => ({ Login: () => <div>Sign in again</div> }));
vi.mock('../src/ui/components/Setup', () => ({ Setup: () => <div>Setup</div> }));
const status = { enabled: true, hasApiKeys: true, assets: [], activeJobs: [], connection: { exchanges: [{ exchange: 'kraken', connected: true }] } };
const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code, headers: { 'Content-Type': 'application/json' } });
beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('reloads Orders after a quick remount, including React StrictMode', async () => {
  const fetch = vi.fn(async (url: string) => json(url.includes('fills') ? [] : url.includes('available') ? { exchanges: [] } : url.includes('keys') ? { keys: [] } : { orders: [] })); vi.stubGlobal('fetch', fetch);
  const first = render(<StrictMode><OrdersPanel /></StrictMode>);
  await screen.findByText('No open orders found.'); first.unmount();
  render(<OrdersPanel />); await screen.findByText('No open orders found.');
  expect(screen.queryByText('Loading orders...')).toBeNull();
});
it('shows an Orders request error and lets the user retry', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  render(<OrdersPanel />); expect(await screen.findByRole('alert')).toBeTruthy();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.includes('fills') ? [] : url.includes('available') ? { exchanges: [] } : url.includes('keys') ? { keys: [] } : { orders: [] })));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByText('No open orders found.');
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});
it('returns to login after an API session expires', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/setup/status') return json({ setupComplete: true });
    if (url === '/api/auth/me') return json({ userId: 'u', username: 'owner' });
    return json(url.startsWith('/api/withdrawals') ? { jobs: [], total: 0 } : status);
  }));
  render(<App />); await screen.findByText('owner');
  vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Authentication required' }, 401)));
  await act(async () => { await expect(apiFetch('/api/status')).rejects.toThrow('session expired'); });
  expect(await screen.findByText('Sign in again')).toBeTruthy();
});
it('shows stale status on disconnect and recovers on browser online', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.startsWith('/api/withdrawals') ? { jobs: [], total: 0 } : status)));
  render(<Dashboard user={{ userId: 'u', username: 'owner' }} onLogout={() => {}} />);
  await screen.findByText('Kraken · Connected');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  await act(async () => { window.dispatchEvent(new Event('online')); });
  expect(await screen.findByRole('alert')).toBeTruthy(); expect(screen.getByText('Status unavailable')).toBeTruthy();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.startsWith('/api/withdrawals') ? { jobs: [], total: 0 } : status)));
  await act(async () => { window.dispatchEvent(new Event('online')); });
  await screen.findByText('Kraken · Connected'); expect(screen.queryByRole('alert')).toBeNull();
});
it('aborts a hung request so subsequent refreshes can proceed', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)))));
  const assertion = expect(apiFetch('/api/status')).rejects.toThrow('Request timed out');
  await vi.advanceTimersByTimeAsync(30000); await assertion;
});
it('shows a retry screen rather than initial setup when the server is offline on launch', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  render(<App />);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByText('Setup')).toBeNull();
  expect(screen.getByRole('button', { name: 'Retry connection' })).toBeTruthy();
});
it('saves Telegram settings before sending a test, and only sends on an explicit click', async () => {
  const { NotificationsPanel } = await import('../src/ui/components/NotificationsPanel');
  let saved = { enabled: false, chatId: '', hasToken: false, pending: 0, lastError: null, lastSentAt: null };
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/test')) return json({ success: true });
    if (options?.method === 'PUT') { const input = JSON.parse(options.body as string); saved = { ...saved, enabled: input.enabled, chatId: input.chatId, hasToken: true }; }
    return json(saved);
  }); vi.stubGlobal('fetch', fetcher);
  render(<NotificationsPanel />); await screen.findByText('No messages sent yet.');
  fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: '123456:abcdefghijklmnopqrstuvwxyz_123456789' } });
  fireEvent.change(screen.getByLabelText('Chat ID'), { target: { value: '123' } });
  expect((screen.getByText('Send test message') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByText('Save settings')); await screen.findByText('Telegram settings saved.');
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/test'))).toBe(false);
  fireEvent.click(screen.getByText('Send test message')); await screen.findByText('Telegram accepted the test message. Check your chat.');
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/test'))).toHaveLength(1);
});

it('keeps onboarding hidden when a configured app is paused', async () => {
  const { SetupGuide } = await vi.importActual<typeof import('../src/ui/components/SetupGuide')>('../src/ui/components/SetupGuide');
  render(<SetupGuide hasApiKeys hasConfiguredAssets isSweeperEnabled={false} onNavigate={() => {}} onToggleSweeper={() => {}} />);
  expect(screen.queryByText('Setup Guide')).toBeNull();
});
it('automatically refreshes orders without requiring a tab change', async () => {
  vi.useFakeTimers();
  const fetcher=vi.fn(async (url:string)=>json(url.includes('fills')?[]:url.includes('available')?{exchanges:[]}:url.includes('keys')?{keys:[]}:{orders:[]})); vi.stubGlobal('fetch',fetcher);
  render(<OrdersPanel />); await act(async()=>{await vi.advanceTimersByTimeAsync(0)});
  const before=fetcher.mock.calls.filter(([url])=>url==='/api/orders').length;
  await act(async()=>{await vi.advanceTimersByTimeAsync(15000)});
  expect(fetcher.mock.calls.filter(([url])=>url==='/api/orders').length).toBe(before+1);
});
it('shows an explicit control error when pause fails and preserves the running state', async () => {
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.startsWith('/api/control')?json({error:'Control unavailable'},503):json(url.startsWith('/api/withdrawals')?{jobs:[],total:0}:status)));
  render(<Dashboard user={{userId:'u',username:'owner'}} onLogout={()=>{}} />);
  fireEvent.click(await screen.findByRole('button',{name:'Pause withdrawals'}));
  expect(await screen.findByText('Control unavailable')).toBeTruthy(); expect(screen.getByText('Withdrawals running')).toBeTruthy();
});
it('labels a zero accumulation bar as zero for assistive technology', async () => {
  const {Progress}=await import('../src/ui/components/ui/progress'); render(<Progress value={0} aria-label="BTC accumulation" />);
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
});

it('shows the balance check while resuming and remains paused on failure', async () => {
  const { deferred } = await import('./helpers'); const resume = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/control/start' ? resume.promise :
    json(url.startsWith('/api/withdrawals') ? { jobs: [], total: 0 } : { ...status, enabled: false })));
  render(<Dashboard user={{ userId: 'u', username: 'owner' }} onLogout={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Resume withdrawals' }));
  expect(await screen.findByRole('button', { name: 'Checking balances…' })).toBeTruthy();
  await act(async () => resume.resolve(json({ error: 'Balance check failed; withdrawals remain paused' }, 409)));
  expect(await screen.findByText('Balance check failed; withdrawals remain paused')).toBeTruthy();
  expect(screen.getByText('Withdrawals paused')).toBeTruthy();
});
it('previews queued amounts and clears only after the user confirms those amounts', async () => {
  const { ClearQueuedAmounts } = await import('../src/ui/components/ClearQueuedAmounts'); const onCleared = vi.fn();
  const fetcher = vi.fn(async (_url: string, options?: RequestInit) => json(options?.method === 'POST' ? { enabled: false } :
    { amounts: [{ exchange: 'kraken', asset: 'BTC', amount: 2 }], activeWithdrawals: 0, token: 'review-token' }));
  vi.stubGlobal('fetch', fetcher); render(<ClearQueuedAmounts onCleared={onCleared} />);
  fireEvent.click(screen.getByRole('button', { name: 'Clear queued amounts…' }));
  await screen.findByText('Kraken · BTC'); expect(fetcher.mock.calls.some(([, o]) => o?.method === 'POST')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Clear these amounts' }));
  await waitFor(() => expect(onCleared).toHaveBeenCalledTimes(1));
  const call = fetcher.mock.calls.find(([, o]) => o?.method === 'POST')!;
  expect(call[0]).toBe('/api/control/queue/clear'); expect(JSON.parse(call[1]!.body as string)).toEqual({ confirmed: true, token: 'review-token' });
});
