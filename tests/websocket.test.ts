import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { KrakenRestClient } from '../src/server/exchanges/kraken/restClient.js';
import { KrakenWsClient } from '../src/server/exchanges/kraken/wsClient.js';
import { trade, deferred } from './helpers.js';

const { sockets, FakeSocket } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');
  const sockets: any[] = [];
  class FakeSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn();
    terminate = vi.fn(() => { this.readyState = 3; this.emit('close'); });
    constructor() { super(); sockets.push(this); }
  }
  return { sockets, FakeSocket };
});
vi.mock('ws', () => ({ default: FakeSocket }));
let clients: KrakenWsClient[] = [];
beforeEach(() => {
  sockets.length = 0; clients = []; vi.useFakeTimers();
  vi.spyOn(KrakenRestClient.prototype, 'getWebSocketsToken').mockResolvedValue({ token: 'fresh', expires: 900 });
});
afterEach(() => { clients.forEach(c => c.disconnect()); vi.useRealTimers(); vi.restoreAllMocks(); });
async function connect() {
  const onFill = vi.fn(), onConnect = vi.fn();
  const client = new KrakenWsClient({ apiKey: 'fake', apiSecret: 'fake', onFill, onConnect });
  clients.push(client); await client.connect();
  const socket = sockets.at(-1)!; socket.emit('open');
  return { client, socket, onFill, onConnect };
}
function subscribed(socket: InstanceType<typeof FakeSocket>) {
  socket.emit('message', Buffer.from(JSON.stringify({ event: 'subscriptionStatus', status: 'subscribed', subscription: { name: 'ownTrades' } })));
}
it('parses the real nested payload and subscribes without old snapshots or consolidated fills', async () => {
  const { client, socket, onFill, onConnect } = await connect();
  expect(client.isConnected()).toBe(false); subscribed(socket); expect(onConnect).toHaveBeenCalledTimes(1);
  socket.emit('message', Buffer.from(JSON.stringify([[{ t1: trade() }, { t2: trade() }], 'ownTrades', { sequence: 1 }])));
  expect(onFill.mock.calls.map(([f]) => f.tradeId)).toEqual(['t1', 't2']);
  expect(JSON.parse(socket.send.mock.calls[0][0]).subscription).toMatchObject({ snapshot: false, consolidate_taker: false });
});
it('terminates a silent connection and reconnects with a fresh token', async () => {
  const { client, socket } = await connect(); subscribed(socket);
  await vi.advanceTimersByTimeAsync(75000);
  expect(socket.terminate).toHaveBeenCalledTimes(1); expect(sockets).toHaveLength(2);
  expect(KrakenRestClient.prototype.getWebSocketsToken).toHaveBeenCalledTimes(2); expect(client.isConnected()).toBe(false);
});
it('recovers subscription rejection even if the socket stays open', async () => {
  const { socket } = await connect();
  socket.emit('message', Buffer.from(JSON.stringify({ event: 'subscriptionStatus', status: 'error', errorMessage: 'token expired' })));
  await vi.advanceTimersByTimeAsync(5000); expect(sockets).toHaveLength(2);
});
it('reconnects on a sequence gap so REST catch-up can recover missed fills', async () => {
  const { socket } = await connect(); subscribed(socket);
  for (const sequence of [1, 3]) socket.emit('message', Buffer.from(JSON.stringify([[{ ['t'+sequence]: trade() }], 'ownTrades', { sequence }])));
  expect(socket.terminate).toHaveBeenCalledTimes(1);
});
it('does not resurrect a removed key while its token request is still in flight', async () => {
  const token = deferred<{ token: string; expires: number }>();
  vi.mocked(KrakenRestClient.prototype.getWebSocketsToken).mockImplementation(() => token.promise);
  const c = new KrakenWsClient({ apiKey: 'fake', apiSecret: 'fake' }); clients.push(c);
  const connecting = c.connect(); c.disconnect(); token.resolve({ token: 'late', expires: 900 }); await connecting;
  await vi.advanceTimersByTimeAsync(60000); expect(sockets).toHaveLength(0);
});
