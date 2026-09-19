import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Switch } from './ui/switch';

interface TelegramStatus {
  enabled: boolean; chatId: string; hasToken: boolean; pending: number;
  healthAlerts?: boolean; outageMinutes?: number; stalledMinutes?: number;
  lastError: string | null; lastSentAt: number | null;
}
const endpoint = '/api/notifications/telegram';
export function NotificationsPanel() {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [chatId, setChatId] = useState('');
  const [botToken, setBotToken] = useState('');
  const [healthAlerts, setHealthAlerts] = useState(true);
  const [outageMinutes, setOutageMinutes] = useState(5), [stalledMinutes, setStalledMinutes] = useState(30);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [chats, setChats] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    const controller = new AbortController();
    let initialized = false, fetching = false;
    const load = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const res = await apiFetch(endpoint, { signal: controller.signal });
        if (!res.ok) throw new Error('Could not load Telegram settings.');
        const data: TelegramStatus = await res.json();
        if (controller.signal.aborted) return;
        setStatus(data);
        if (!initialized) { setEnabled(data.enabled); setChatId(data.chatId); setHealthAlerts(data.healthAlerts ?? true); setOutageMinutes(data.outageMinutes ?? 5); setStalledMinutes(data.stalledMinutes ?? 30); setLoaded(true); initialized = true; }
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Connection failed.'); }
      finally { fetching = false; }
    };
    void load();
    const timer = setInterval(load, 10000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [refresh]);
  const dirty = enabled !== status?.enabled || chatId.trim() !== status?.chatId || !!botToken.trim() || healthAlerts !== (status?.healthAlerts ?? true) || outageMinutes !== (status?.outageMinutes ?? 5) || stalledMinutes !== (status?.stalledMinutes ?? 30);
  async function save() {
    setBusy(true); setError(''); setNotice('');
    try {
      const res = await apiFetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, healthAlerts, outageMinutes, stalledMinutes, chatId: chatId.trim(), ...(botToken.trim() ? { botToken: botToken.trim() } : {}) }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save Telegram settings.');
      setStatus(data); setChatId(data.chatId); setBotToken(''); setNotice('Telegram settings saved.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save settings.'); }
    finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setError(''); setNotice('');
    try {
      const res = await apiFetch(`${endpoint}/test`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not send test message.');
      setNotice('Telegram accepted the test message. Check your chat.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not send test message.'); }
    finally { setBusy(false); }
  }
  async function findChats() {
    setBusy(true); setError(''); setNotice(''); setChats([]);
    try {
      const res = await apiFetch(`${endpoint}/chats`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(botToken.trim() ? { botToken: botToken.trim() } : {}) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not find chats.');
      setChats(data.chats);
      if (!data.chats.length) setNotice('No recent private chats found. Send /start to your bot and try again.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not find chats.'); }
    finally { setBusy(false); }
  }
  return <Card>
    <CardHeader><CardTitle>Telegram notifications</CardTitle></CardHeader>
    <CardContent className="space-y-6">
      <p className="text-sm text-muted-foreground">Get an alert when withdrawals start, completion summaries about once a minute,
        and prompt alerts for held, failed, cancelled, or uncertain withdrawals. Moby must be running to send alerts.</p>
      <details open={!status?.hasToken}><summary className="cursor-pointer text-sm">Bot setup instructions</summary><ol className="mt-3 list-decimal pl-5 text-sm space-y-2">
        <li>Create a bot with <a className="underline" href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a> and copy its token.</li>
        <li>Open your bot in Telegram and send /start. Click Find my chat and select your name, or enter a numeric chat ID or @channel name.</li>
        <li>Save these settings and send a test message before enabling alerts.</li>
      </ol></details>
      {error && <div role="alert" className="text-sm text-destructive">{error} {!loaded && <Button variant="outline" onClick={() => setRefresh(v => v + 1)}>Retry</Button>}</div>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      <div className="max-w-xl space-y-4">
        <div className="space-y-2"><Label htmlFor="telegram-token">Bot token</Label>
          <Input id="telegram-token" type="password" autoComplete="new-password" value={botToken} disabled={busy || !loaded}
            placeholder={status?.hasToken ? 'Saved — leave blank to keep' : 'Paste your bot token'} onChange={e => setBotToken(e.target.value)} />
        </div>
        <div className="space-y-2"><Label htmlFor="telegram-chat">Chat ID</Label>
          <Input id="telegram-chat" value={chatId} disabled={busy || !loaded} placeholder="123456789" onChange={e => setChatId(e.target.value)} />
          <Button variant="outline" onClick={findChats} disabled={busy || !loaded || (!botToken.trim() && !status?.hasToken)}>Find my chat</Button>
          {chats.length > 0 && <div className="flex flex-wrap gap-2">{chats.map(chat => <Button key={chat.id} variant="outline" disabled={busy}
            onClick={() => { setChatId(chat.id); setChats([]); }}>{chat.name} ({chat.id})</Button>)}</div>}
        </div>
        <div className="flex items-center gap-3"><Switch id="telegram-enabled" checked={enabled} onCheckedChange={setEnabled} disabled={busy || !loaded} />
          <Label htmlFor="telegram-enabled">Enable automatic alerts</Label>
        </div>
        <fieldset className="border-t pt-4 space-y-3">
          <legend className="text-sm font-medium pt-3">Connection and delay alerts</legend>
          <div className="flex gap-3 items-center"><Switch id="health-alerts" checked={healthAlerts} onCheckedChange={setHealthAlerts} disabled={busy || !loaded} /><Label htmlFor="health-alerts">Notify about outages and stalled withdrawals</Label></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label htmlFor="outage-minutes">Outage delay (minutes)</Label><Input id="outage-minutes" type="number" min="1" max="1440" value={outageMinutes} disabled={busy || !loaded || !healthAlerts} onChange={e => setOutageMinutes(Number(e.target.value))} /></div>
            <div><Label htmlFor="stalled-minutes">Stalled delay (minutes)</Label><Input id="stalled-minutes" type="number" min="1" max="10080" value={stalledMinutes} disabled={busy || !loaded || !healthAlerts} onChange={e => setStalledMinutes(Number(e.target.value))} /></div>
          </div>
          <p className="text-xs text-muted-foreground">One alert per outage or stalled withdrawal, plus connection recovery. Delivery waits if Telegram is unreachable. Moby must remain running; it cannot report its own shutdown.</p>
        </fieldset>
        <div className="flex gap-3"><Button onClick={save} disabled={busy || !loaded || !dirty}>Save settings</Button>
          <Button variant="outline" onClick={test} disabled={busy || !loaded || dirty || !status?.hasToken || !status.chatId}>Send test message</Button>
        </div>
      </div>
      {status && <div className="text-sm text-muted-foreground space-y-1">
        <p>{status.enabled ? 'Automatic alerts enabled' : 'Automatic alerts disabled'} · {status.pending} queued event{status.pending === 1 ? '' : 's'}</p>
        <p>{status.lastSentAt ? `Last accepted by Telegram: ${new Date(status.lastSentAt).toLocaleString()}` : 'No messages sent yet.'}</p>
        {status.lastError && <p role="alert" className="text-destructive">{status.lastError}</p>}
      </div>}
      <p className="text-xs text-muted-foreground">Alerts begin with future status changes when enabled. Changing the recipient or token clears queued alerts.
        If Telegram accepts a message but its reply is lost, a retry can produce a duplicate alert.</p>
    </CardContent>
  </Card>;
}
