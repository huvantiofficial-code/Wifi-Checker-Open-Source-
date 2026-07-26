'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { performance: nodePerformance } = require('node:perf_hooks');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'servers.js'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

function createElement(id) {
  const listeners = {};
  return {
    id,
    style: {},
    dataset: {},
    textContent: '',
    innerHTML: '',
    value: id === 'serverSel' ? 'auto' : '',
    disabled: false,
    hidden: id === 'shareRow',
    options: [],
    parentNode: { setAttribute() {} },
    classList: { add() {}, remove() {} },
    setAttribute() {},
    addEventListener(type, listener) { listeners[type] = listener; },
    appendChild(child) { this.options.push(child); },
    listeners
  };
}

function loadApp(overrides = {}) {
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
  const nodes = Object.fromEntries(ids.map(id => [id, createElement(id)]));
  const documentListeners = {};
  const sandbox = {
    AbortController,
    Blob,
    Math,
    Promise,
    Uint8Array,
    XMLHttpRequest: function () {},
    clearInterval,
    clearTimeout,
    console,
    document: {
      hidden: false,
      getElementById: id => nodes[id] || null,
      createElement: () => createElement('option'),
      addEventListener(type, listener) { documentListeners[type] = listener; }
    },
    fetch: async url => ({
      ok: true,
      status: 200,
      url,
      body: null,
      arrayBuffer: async () => new ArrayBuffer(0),
      json: async () => ({})
    }),
    isFinite,
    navigator: { onLine: true, userAgent: 'Node smoke test' },
    performance: {
      now: () => 0,
      getEntriesByName: () => []
    },
    setInterval,
    setTimeout,
    window: { prompt() {} }
  };
  Object.assign(sandbox, overrides);
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.crypto = webcrypto;

  vm.createContext(sandbox);
  vm.runInContext(serverSource, sandbox, { filename: 'servers.js' });
  vm.runInContext(appSource, sandbox, { filename: 'app.js' });
  return { sandbox, nodes, documentListeners };
}

test('application initializes and binds every required UI element', () => {
  const { sandbox, nodes, documentListeners } = loadApp();
  assert.equal(sandbox.SERVERS.length, 44);
  assert.equal(nodes.serverSel.options.length, sandbox.SERVERS.length);
  assert.match(nodes.serverSel.innerHTML, /Auto \(best ping\)/);
  assert.equal(typeof nodes.btn.listeners.click, 'function');
  assert.equal(typeof nodes.serverSel.listeners.change, 'function');
  assert.equal(typeof nodes.copyBtn.listeners.click, 'function');
  assert.equal(typeof documentListeners.visibilitychange, 'function');

  const referencedIds = [...appSource.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]);
  assert.ok(referencedIds.every(id => nodes[id]), 'every literal DOM binding must exist in index.html');
});

test('server catalog is unique, secure, and auto candidates are valid', () => {
  const { sandbox } = loadApp();
  const names = sandbox.SERVERS.map(server => server.name);
  const endpoints = sandbox.SERVERS.map(server => server.server);
  assert.equal(new Set(names).size, names.length);
  assert.equal(new Set(endpoints).size, endpoints.length);
  assert.ok(endpoints.every(endpoint => endpoint.startsWith('https://')));
  assert.ok(sandbox.SERVERS.every(server => {
    const target = sandbox.urls(server);
    return ['ping', 'dl', 'ul', 'ip'].every(key => target[key].startsWith('https://'));
  }));
  assert.ok(sandbox.AUTO_CANDIDATES.length >= 10);
  assert.ok(sandbox.AUTO_CANDIDATES.every(name => names.includes(name)));
});

test('bandwidth formatting and upload payload remain deterministic', () => {
  const { sandbox } = loadApp();
  assert.equal(sandbox.mbps(125000, 1), 1.06);
  assert.equal(sandbox.mbps(100, 0), 0);
  assert.equal(sandbox.fmt(9.876), '9.88');
  assert.equal(sandbox.fmt(123.4), '123');
  const payload = sandbox.makeBlob(2);
  assert.equal(payload.size, 2 * 1048576);
  assert.equal(payload.type, '');
});

test('upload payload supports sub-megabyte sizes for slow links', () => {
  const { sandbox } = loadApp();
  assert.equal(sandbox.makeBlob(0.25).size, 262144);
  assert.equal(sandbox.makeBlob(0.125).size, 131072);
  assert.equal(sandbox.makeBlob(1.5).size, 1572864);
  // Auto-scaling must stay inside the configured envelope and snap to a small
  // ladder of sizes so the payload cache cannot grow without bound.
  assert.equal(sandbox.clampChunkMB(0), sandbox.CFG.ulChunkMinMB);
  assert.equal(sandbox.clampChunkMB(-5), sandbox.CFG.ulChunkMinMB);
  assert.equal(sandbox.clampChunkMB(1e6), sandbox.CFG.ulChunkMaxDesktopMB);
  const ladder = new Set();
  for (let mb = 0.01; mb < 500; mb *= 1.15) ladder.add(sandbox.clampChunkMB(mb));
  assert.ok(ladder.size <= 12, `payload ladder stayed small (${ladder.size} sizes)`);
  for (const size of ladder) {
    assert.ok(size >= sandbox.CFG.ulChunkMinMB && size <= sandbox.CFG.ulChunkMaxDesktopMB);
  }
});

/* Regression: xhr.upload.onprogress reports bytes accepted by the socket send
   buffer, not bytes delivered. When the buffer swallows a whole payload the
   progress events claim it was "uploaded" instantly, which used to inflate the
   reported speed far above the real uplink rate. */
test('upload speed is measured from acknowledged requests, not buffered bytes', async () => {
  const BYTES_PER_SEC = 2 * 1048576;       // real per-connection uplink
  const STREAMS = 2;
  let ackedBytes = 0;

  class BufferSwallowingXHR {
    constructor() {
      this.upload = {};
      this.status = 0;
      this.finished = false;
    }
    open() {}
    send(body) {
      const size = body.size;
      // The send buffer accepts the entire body immediately.
      if (this.upload.onprogress) this.upload.onprogress({ loaded: size, total: size });
      // The server only answers once the bytes have really been transmitted.
      this.timer = setTimeout(() => {
        if (this.finished) return;
        this.finished = true;
        this.status = 200;
        ackedBytes += size;
        if (this.onloadend) this.onloadend();
      }, (size / BYTES_PER_SEC) * 1000);
    }
    abort() {
      if (this.finished) return;
      clearTimeout(this.timer);
      this.finished = true;
      this.status = 0;
      if (this.onloadend) this.onloadend();
    }
  }

  const { sandbox, nodes } = loadApp({
    XMLHttpRequest: BufferSwallowingXHR,
    performance: nodePerformance
  });
  Object.assign(sandbox.CFG, {
    ulSeconds: 1.2,
    ulMaxSeconds: 4,
    graceUl: 0.15,
    ulStreams: STREAMS,
    ulMinAcks: 2,
    ulTargetRequestMs: 300,
    ulChunkStartMB: 0.25
  });

  const startedAt = nodePerformance.now();
  const reported = await sandbox.upload(sandbox.SERVERS[0], new AbortController().signal);
  const wall = (nodePerformance.now() - startedAt) / 1000;

  const truth = (ackedBytes * 8 * sandbox.CFG.overhead) / (wall * 1e6);
  const inflated = (BYTES_PER_SEC * STREAMS * 8 * sandbox.CFG.overhead) / 1e6 * 2;

  assert.ok(reported > 0, 'upload must produce a positive result');
  assert.ok(
    Math.abs(reported - truth) / truth < 0.2,
    `reported ${reported.toFixed(2)} Mbps should track the real ${truth.toFixed(2)} Mbps`
  );
  assert.ok(
    reported < inflated,
    'reported speed must not follow instant socket-buffer progress events'
  );
  // The live readout is written by the sampling timer, so it tracks the final
  // figure closely rather than matching the last digit exactly.
  const displayed = Number.parseFloat(nodes.ulVal.textContent);
  assert.ok(Number.isFinite(displayed) && displayed > 0, 'live upload value must be displayed');
  assert.ok(
    Math.abs(displayed - reported) / reported < 0.1,
    `displayed ${displayed} should track the returned ${reported.toFixed(2)} Mbps`
  );
});

test('upload fails cleanly when the backend never acknowledges a request', async () => {
  class RejectingXHR {
    constructor() { this.upload = {}; this.status = 0; this.finished = false; }
    open() {}
    send(body) {
      // Bytes leave the buffer, but CORS/network failure means status stays 0.
      if (this.upload.onprogress) this.upload.onprogress({ loaded: body.size, total: body.size });
      this.timer = setTimeout(() => {
        if (this.finished) return;
        this.finished = true;
        this.status = 0;
        if (this.onloadend) this.onloadend();
      }, 5);
    }
    abort() {
      if (this.finished) return;
      clearTimeout(this.timer);
      this.finished = true;
      this.status = 0;
      if (this.onloadend) this.onloadend();
    }
  }

  const { sandbox } = loadApp({ XMLHttpRequest: RejectingXHR, performance: nodePerformance });
  Object.assign(sandbox.CFG, {
    ulSeconds: 0.4, ulMaxSeconds: 1.5, graceUl: 0.05, ulStreams: 2
  });

  await assert.rejects(
    () => sandbox.upload(sandbox.SERVERS[0], new AbortController().signal),
    /upload failed/
  );
});

test('a complete mocked test produces usable download and upload results', async () => {
  const fetch = async url => {
    if (url.includes('/meta')) {
      return {
        ok: true,
        status: 200,
        url,
        json: async () => ({ clientIp: '203.0.113.5', asOrganization: 'Example ISP', country: 'BD', colo: { city: 'Dhaka', iata: 'DAC' } })
      };
    }
    if (url.includes('bytes=0')) {
      return { ok: true, status: 200, url, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    let reads = 0;
    return {
      ok: true,
      status: 200,
      url,
      body: {
        getReader() {
          return {
            read: () => new Promise(resolve => setTimeout(() => {
              reads++;
              resolve(reads <= 3 ? { done: false, value: new Uint8Array(65536) } : { done: true });
            }, 1)),
            cancel: async () => {}
          };
        }
      }
    };
  };

  class FakeXHR {
    constructor() {
      this.upload = {};
      this.status = 0;
      this.ended = false;
    }
    open() {}
    send(payload) {
      this.timer = setTimeout(() => {
        if (this.ended) return;
        if (this.upload.onprogress) this.upload.onprogress({ loaded: payload.size });
        this.status = 200;
        this.ended = true;
        if (this.onloadend) this.onloadend();
      }, 2);
    }
    abort() {
      if (this.ended) return;
      clearTimeout(this.timer);
      this.ended = true;
      this.status = 0;
      if (this.onloadend) this.onloadend();
    }
  }

  const { sandbox, nodes } = loadApp({ fetch, XMLHttpRequest: FakeXHR, performance: nodePerformance });
  sandbox.CFG.pingCount = 4;
  sandbox.CFG.dlSeconds = 0.25;
  sandbox.CFG.ulSeconds = 0.25;
  sandbox.CFG.graceDl = 0.02;
  sandbox.CFG.graceUl = 0.02;
  sandbox.CFG.dlStreams = 2;
  sandbox.CFG.ulStreams = 2;
  nodes.serverSel.value = '0';

  await sandbox.run();
  assert.equal(sandbox.state, 'idle');
  assert.equal(nodes.bigLabel.textContent, 'Complete');
  assert.ok(Number.parseFloat(nodes.dlVal.textContent) > 0);
  assert.ok(Number.parseFloat(nodes.ulVal.textContent) > 0);
  assert.equal(nodes.shareRow.hidden, false);
  assert.equal(nodes.ipVal.textContent, '203.0.113.5');
});

test('offline starts fail immediately without entering a broken running state', async () => {
  const navigator = { onLine: false, userAgent: 'Node smoke test' };
  const { sandbox, nodes } = loadApp({ navigator });
  await sandbox.run();
  assert.equal(sandbox.state, 'idle');
  assert.equal(nodes.bigLabel.textContent, 'Failed');
  assert.equal(nodes.serverName.textContent, 'No internet connection');
});

test('stopping during server selection cannot overwrite the stopped UI', async () => {
  const fetch = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const { sandbox, nodes } = loadApp({ fetch });
  const running = sandbox.run();
  sandbox.stop();
  await running;
  assert.equal(sandbox.state, 'idle');
  assert.equal(nodes.bigLabel.textContent, 'Stopped');
  assert.equal(nodes.btn.textContent, 'Start');
});

test('jitter is calculated in sample order rather than sorted order', async () => {
  const rtts = [100, 10, 50, 20, 60, 30, 70, 40, 80, 50];
  let request = 0;
  let nowCall = 0;
  let clock = 0;
  const performance = {
    now() {
      if (nowCall++ % 2 === 0) return clock;
      clock += rtts[request++];
      return clock;
    },
    getEntriesByName: () => []
  };
  const { sandbox } = loadApp({ performance });
  const result = await sandbox.ping(sandbox.SERVERS[0], 10, new AbortController().signal);
  assert.equal(result.ping, 10);
  assert.equal(result.jitter, 35);
});
