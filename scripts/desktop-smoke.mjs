import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const profile = mkdtempSync('/tmp/moby-desktop-smoke-');
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const binary = resolve(process.argv[2] || `release/Moby-${JSON.parse(readFileSync('package.json', 'utf8')).version}.AppImage`);
const child = spawn(binary, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], {
  detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production',
    MOBY_TEST_DATA_PATH: profile, MOBY_ENCRYPTION_KEY: randomBytes(32).toString('hex'), LOG_LEVEL: 'silent' },
});
let output = '', socket;
child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  let target;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Desktop exited (${child.exitCode ?? child.signalCode}): ${output.slice(-4000)}`);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json();
      target = targets.find(target => target.type === 'page' && /^http:\/\/(127\.0\.0\.1|localhost):/.test(target.url));
      if (target) break;
    } catch { /* Browser startup is still in progress. */ }
    await sleep(200);
  }
  assert.ok(target, `No desktop page started: ${output.slice(-4000)}`);
  socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket, 'open');
  let id = 0; const pending = new Map();
  socket.on('message', message => {
    const response = JSON.parse(message.toString());
    if (response.id && pending.has(response.id)) {
      const { resolve, reject, timer } = pending.get(response.id); clearTimeout(timer); pending.delete(response.id);
      if (response.error) reject(new Error(response.error.message)); else resolve(response.result);
    }
  });
  function command(method, params = {}) {
    return new Promise((resolve, reject) => {
      const requestId = ++id, timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timed out`)); }, 15000);
      pending.set(requestId, { resolve, reject, timer }); socket.send(JSON.stringify({ id: requestId, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate("location.protocol === 'http:' && document.readyState !== 'loading'")) break;
    await sleep(100);
  }
  const password = randomBytes(16).toString('hex');
  const setup = await evaluate(`fetch('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify({ username: 'desktop-smoke', password }))} }).then(async response => ({ status: response.status, body: await response.json() }))`);
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  await command('Page.reload');
  let tabs = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    try { tabs = await evaluate("Array.from(document.querySelectorAll('[role=tab]'), tab => tab.textContent)"); } catch { /* Reload. */ }
    if (tabs.includes('Notifications')) break;
    await sleep(100);
  }
  assert.ok(tabs.includes('Notifications'), `Missing Notifications tab: ${JSON.stringify(tabs)}`);
  await evaluate("document.querySelectorAll('[role=tab]').forEach(tab => { if (tab.textContent === 'Notifications') { tab.focus(); tab.click(); } })");
  let text;
  for (let attempt = 0; attempt < 30; attempt++) {
    text = await evaluate('document.body.innerText'); if (/Telegram notifications/i.test(text)) break; await sleep(100);
  }
  assert.match(text, /Telegram notifications/i); assert.match(text, /Find my chat/); assert.match(text, /Send test message/);
  const status = await evaluate("fetch('/api/status').then(r => r.json())");
  assert.equal(status.enabled, false); assert.equal(status.hasApiKeys, false); assert.equal(status.activeJobs.length, 0);
  const telegram = await evaluate("fetch('/api/notifications/telegram').then(r => r.json())");
  assert.equal(telegram.enabled, false); assert.equal(telegram.hasToken, false);
  const screenshot = await command('Page.captureScreenshot', { format: 'png' });
  writeFileSync(profile + '/notifications.png', Buffer.from(screenshot.data, 'base64'));
  console.log(JSON.stringify({ passed: true, binary, profile, tabs, screenshot: profile + '/notifications.png' }));  if (process.env.MOBY_LAYOUT_REVIEW === '1') {
    const now = Date.now();
    const sample = { enabled:true,dryRun:false,hasApiKeys:true,updatedAt:now,
      connection:{exchanges:[{exchange:'kraken',connected:true,lastSuccessAt:now},{exchange:'gemini',connected:false,error:null}]},
      summary:{pendingAssets:1,activeWithdrawals:2,needsAttention:1,completed24h:12}, feeBudget:{limitUsd:25,reservedUsd:4.2,unpriced:0,remainingUsd:20.8,nextExpiryAt:now+3600000},
      assets:[
        {exchange:'kraken',asset:'BTC',enabled:true,threshold:0.001,pendingAmount:0.02,rrIndex:0,lastWithdrawAt:now-900000,consecutiveFailures:2,backoffUntil:now+600000,state:'On hold',reason:'The exchange is holding a withdrawal for this asset',attention:true,nextEligibleAt:null,nextWallet:'Cold wallet BTC',network:'Bitcoin',chunkAmount:0.001,chunkCurrency:'BTC',estimatedFee:0.00001,minimum:0.0001},
        {exchange:'gemini',asset:'ETH',enabled:true,threshold:0.1,pendingAmount:0,rrIndex:0,lastWithdrawAt:null,consecutiveFailures:0,backoffUntil:null,state:'Waiting',reason:'Waiting for a new eligible order fill',attention:false,nextEligibleAt:null,nextWallet:'Cold wallet ETH',network:'Ethereum',chunkAmount:0,chunkCurrency:'ETH',estimatedFee:0.001,minimum:0.01},
      ],activeJobs:[
        {id:'demo-held',exchange:'kraken',asset:'BTC',method:'Bitcoin',amount:0.001,status:'held',destKey:'Cold wallet BTC',destinationAddress:'example-address-for-layout-only',createdAt:now-900000,updatedAt:now-20000,pollCount:4,exchangeRef:'DEMO-REF-ONE',quotedFee:0.00001,lastError:'Waiting for exchange approval'},
        {id:'demo-pending',exchange:'gemini',asset:'ETH',method:'Ethereum',amount:0.03,status:'pending',destKey:'Cold wallet ETH',createdAt:now-180000,updatedAt:now-5000,pollCount:2,exchangeRef:'DEMO-REF-TWO',quotedFee:0.001}
      ]};
    const history = [{...sample.activeJobs[0],id:'demo-completed',status:'complete',amount:0.001,txid:'example-transaction-id',actualFee:0.00001}];
    await evaluate(`window.__layoutSample = ${JSON.stringify(sample)}; window.__layoutHistory = ${JSON.stringify(history)};
      const actualFetch = window.fetch.bind(window); window.fetch = (url, options) => {
        const parsed = new URL(typeof url === 'string' ? url : url.url, location.href);
        if (parsed.pathname === '/api/status') return Promise.resolve(new Response(JSON.stringify(window.__layoutSample),{headers:{'Content-Type':'application/json'}}));
        if (parsed.pathname === '/api/withdrawals') return Promise.resolve(new Response(JSON.stringify({jobs:window.__layoutHistory,total:window.__layoutHistory.length}),{headers:{'Content-Type':'application/json'}}));
        if (parsed.pathname === '/api/control/queue') return Promise.resolve(new Response(JSON.stringify({amounts:window.__layoutSample.assets.filter(a=>a.pendingAmount>0).map(a=>({exchange:a.exchange,asset:a.asset,amount:a.pendingAmount})),activeWithdrawals:window.__layoutSample.activeJobs.length,token:'layout-only'}),{headers:{'Content-Type':'application/json'}}));
        return actualFetch(url,options);
      }; window.dispatchEvent(new Event('online'));`);
    await evaluate("{ const tab=[...document.querySelectorAll('[role=tab]')].find(tab=>tab.textContent==='Overview'); tab.focus(); tab.click(); }"); await sleep(500);
    const layouts=[];
    for (const scenario of [{width:1200,height:800,name:'running'},{width:800,height:600,name:'paused'}]) {
      await command('Emulation.setDeviceMetricsOverride',{width:scenario.width,height:scenario.height,deviceScaleFactor:1,mobile:false});
      if(scenario.name==='paused') await evaluate("window.__layoutSample.enabled=false; window.__layoutSample.assets[1].state='Paused'; window.__layoutSample.assets[1].reason='Withdrawals are paused; fill monitoring continues'; window.dispatchEvent(new Event('online'))");
      await sleep(500); await evaluate('window.scrollTo(0,0)');
      const geometry=await evaluate("({width:innerWidth,pageWidth:document.documentElement.scrollWidth,tabsTop:document.querySelector('[role=tablist]').getBoundingClientRect().top,setup:document.body.innerText.includes('Setup Guide'),zero:[...document.querySelectorAll('[role=progressbar]')].some(e=>e.getAttribute('aria-valuenow')==='0')})");
      assert.ok(geometry.pageWidth<=geometry.width+1,JSON.stringify(geometry)); assert.ok(geometry.tabsTop<100,JSON.stringify(geometry)); assert.equal(geometry.setup,false); assert.equal(geometry.zero,true,JSON.stringify(geometry));
      if(scenario.name==='paused') assert.match(await evaluate('document.body.innerText'),/Withdrawals paused/);
      const metrics=await command('Page.getLayoutMetrics');
      const shot=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:scenario.width,height:metrics.cssContentSize.height,scale:1}});
      const path=profile+'/'+scenario.name+'.png';writeFileSync(path,Buffer.from(shot.data,'base64')); layouts.push({...scenario,...geometry,screenshot:path});
    }
    console.log(JSON.stringify({layouts}));
    await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Clear queued amounts…').click()");
    await sleep(300);
    const queueDialog=await evaluate("({text:document.querySelector('[role=dialog]')?.innerText,disabled:[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='Clear these amounts')?.disabled,height:document.querySelector('[role=dialog]')?.getBoundingClientRect().height,viewport:innerHeight})");
    assert.match(queueDialog.text,/Kraken/); assert.match(queueDialog.text,/still active/); assert.equal(queueDialog.disabled,true);
    assert.ok(queueDialog.height<=queueDialog.viewport,JSON.stringify(queueDialog));
    const queueShot=await command('Page.captureScreenshot',{format:'png'});
    writeFileSync(profile+'/queue-review.png',Buffer.from(queueShot.data,'base64'));
    console.log(JSON.stringify({queueReview:queueDialog,screenshot:profile+'/queue-review.png'}));
  }

} finally {
  socket?.close();
  if (child.exitCode === null && child.signalCode === null) {
    const done = once(child, 'exit');
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    await Promise.race([done, sleep(5000)]);
    if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  }
}
