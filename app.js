/* Wifi Checker - speed test engine
   Backends: Cloudflare (__down/__up/meta) + LibreSpeed public servers (garbage.php/empty.php). */

var CFG = {
  pingCount: 10,
  pingTimeout: 4000,
  probeTimeout: 3000,
  dlSeconds: 10,
  ulSeconds: 10,
  graceDl: 1.5,
  graceUl: 2.5,
  dlStreams: 6,
  ulStreams: 3,
  chunkMB: 100,         // larger requests avoid request overhead on fast links
  ulChunkDesktopMB: 20,
  ulChunkMobileMB: 4,   // avoids browser memory pressure on mobile devices
  overhead: 1.06        // TCP/IP + TLS overhead compensation (LibreSpeed default)
};

var $ = function (id) { return document.getElementById(id); };
var state = 'idle';
var abort = null;
var runId = 0;
var server = null;
var result = { ping: 0, jitter: 0, dl: 0, ul: 0 };

/* ---------- helpers ---------- */
function sep(u) { return u.indexOf('?') > -1 ? '&' : '?'; }
function join(base, path) { return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, ''); }
function nocache(u) { return u + sep(u) + 'r=' + Math.random(); }

function linkedController(parentSignal) {
  var ctl = new AbortController();
  var relay = function () { ctl.abort(); };
  if (parentSignal) {
    if (parentSignal.aborted) ctl.abort();
    else parentSignal.addEventListener('abort', relay, { once: true });
  }
  return {
    signal: ctl.signal,
    abort: function () { ctl.abort(); },
    release: function () {
      if (parentSignal) parentSignal.removeEventListener('abort', relay);
    }
  };
}

async function timedFetch(url, options, timeout, parentSignal) {
  var linked = linkedController(parentSignal);
  var timer = setTimeout(linked.abort, timeout);
  var requestOptions = Object.assign({}, options || {}, { signal: linked.signal });
  try {
    return await fetch(url, requestOptions);
  } finally {
    clearTimeout(timer);
    linked.release();
  }
}

function urls(s) {
  if (s.type === 'cloudflare') {
    return {
      ping: s.server + '/__down?bytes=0',
      dl: s.server + '/__down?bytes=' + (CFG.chunkMB * 1048576),
      ul: s.server + '/__up',
      ip: s.server + '/meta'
    };
  }
  return {
    ping: join(s.server, s.pingURL) + '?cors=true',
    dl: join(s.server, s.dlURL) + '?cors=true&ckSize=' + CFG.chunkMB,
    ul: join(s.server, s.ulURL) + '?cors=true',
    ip: join(s.server, s.getIpURL) + '?cors=true&isp=true'
  };
}

function wait(ms, signal) {
  return new Promise(function (res) {
    if (signal && signal.aborted) { res(); return; }
    var t = setTimeout(done, ms);
    function done() { clearTimeout(t); if (signal) signal.removeEventListener('abort', done); res(); }
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}

function mbps(bytes, seconds) {
  if (!(seconds > 0)) return 0;
  return (bytes * 8 * CFG.overhead) / (seconds * 1e6);
}

function fmt(v) {
  if (!isFinite(v) || v <= 0) return '0.00';
  return v >= 100 ? v.toFixed(0) : v.toFixed(2);
}

/* ---------- gauge ---------- */
var GAUGE_LEN = 2 * Math.PI * 84 * 0.75; // 270deg arc
var arc = $('gaugeArc');
arc.style.strokeDasharray = GAUGE_LEN + ' ' + (2 * Math.PI * 84);

function gauge(speed) {
  var p = speed <= 0 ? 0 :
    speed <= 10 ? speed / 10 * 0.33 :
    speed <= 100 ? 0.33 + (speed - 10) / 90 * 0.34 :
    0.67 + Math.min(speed - 100, 900) / 900 * 0.33;
  arc.style.strokeDashoffset = GAUGE_LEN * (1 - Math.max(0, Math.min(1, p)));
  $('bigVal').textContent = fmt(speed);
}

function setLive(label, speed) {
  $('bigLabel').textContent = label;
  $('testCard').dataset.phase = label.toLowerCase().replace(/[^a-z]+/g, '-');
  gauge(speed);
}

function setProgress(value) {
  var progress = Math.max(0, Math.min(100, value));
  $('bar').style.width = progress + '%';
  $('bar').parentNode.setAttribute('aria-valuenow', Math.round(progress));
}

/* ---------- ping ---------- */
async function ping(s, count, signal, onProgress) {
  var u = urls(s).ping, samples = [];
  var warmed = false, attempts = 0, consecutiveFailures = 0;
  var wanted = Math.max(3, count - 1);

  while (samples.length < wanted && attempts < count + 3) {
    attempts++;
    var t = performance.now();
    try {
      var r = await timedFetch(nocache(u), { cache: 'no-store', mode: 'cors' }, CFG.pingTimeout, signal);
      if (!r.ok) throw new Error('ping HTTP ' + r.status);
      await r.arrayBuffer();
      var rtt = performance.now() - t;
      var e = performance.getEntriesByName ? performance.getEntriesByName(r.url) : [];
      var last = e && e.length ? e[e.length - 1] : null;
      if (last && last.responseStart > 0 && last.requestStart > 0) {
        var precise = last.responseStart - last.requestStart;
        if (precise > 0 && precise < rtt) rtt = precise;
      }
      if (rtt > 0) {
        if (warmed) samples.push(rtt);
        else warmed = true;                  // discard the first successful request
      }
      consecutiveFailures = 0;
      if (onProgress) onProgress(Math.min(1, (samples.length + (warmed ? 1 : 0)) / count));
    } catch (err) {
      if (signal && signal.aborted) throw err;
      consecutiveFailures++;
      if (consecutiveFailures >= 3) break;   // do not hang on an unavailable server
    }
  }

  if (samples.length < 3) throw new Error('ping failed');
  var min = Math.min.apply(Math, samples), jit = 0;
  // Jitter must use collection order; sorting would incorrectly hide latency spikes.
  for (var k = 1; k < samples.length; k++) jit += Math.abs(samples[k] - samples[k - 1]);
  return { ping: min, jitter: jit / (samples.length - 1) };
}

/* ---------- download ---------- */
async function download(s, signal) {
  var u = urls(s).dl, bytes = 0, graced = 0, start = performance.now(), graceDone = false;
  var running = true, live = 0, tasks = [];
  var phase = linkedController(signal);

  function loop() {
    return (async function () {
      while (running) {
        try {
          var res = await fetch(nocache(u), { cache: 'no-store', signal: phase.signal, mode: 'cors' });
          if (!res.ok || !res.body || !res.body.getReader) throw new Error('bad download response');
          var reader = res.body.getReader();
          while (running) {
            var c = await reader.read();
            if (!running || c.done) break;
            bytes += c.value.length;
            if (graceDone) graced += c.value.length;
          }
          try { await reader.cancel(); } catch (e) {}
        } catch (e) {
          if (!running || phase.signal.aborted) return;
          await wait(200, signal);
        }
      }
    })();
  }

  for (var i = 0; i < CFG.dlStreams; i++) {
    tasks.push(loop());
    await wait(60, signal);
    if (signal && signal.aborted) break;
  }

  var graceStart = 0;
  var timer = setInterval(function () {
    var el = (performance.now() - start) / 1000;
    if (!graceDone && el >= CFG.graceDl) { graceDone = true; graced = 0; graceStart = performance.now(); }
    if (graceDone) {
      live = mbps(graced, (performance.now() - graceStart) / 1000);
      setLive('Download', live);
      $('dlVal').textContent = fmt(live);
    }
    setProgress(15 + Math.min(1, el / CFG.dlSeconds) * 42.5);
  }, 150);

  await wait(Math.max(0, CFG.dlSeconds * 1000 - (performance.now() - start)), signal);
  var end = performance.now();
  running = false;
  clearInterval(timer);
  phase.abort();                            // cancel in-flight requests before upload starts
  await Promise.all(tasks);
  phase.release();
  if (signal && signal.aborted) throw new Error('aborted');

  var measuredSeconds = graceDone ? (end - graceStart) / 1000 : 0;
  var speed = mbps(graced, measuredSeconds);
  if (!(speed > 0)) speed = mbps(bytes, (end - start) / 1000);
  if (!(speed > 0)) throw new Error('download failed');
  return speed;
}

/* ---------- upload ---------- */
function uploadChunkMB() {
  var ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  var mobile = /Android|iPhone|iPad|iPod|Windows Phone/i.test(ua) ||
    (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  return mobile ? CFG.ulChunkMobileMB : CFG.ulChunkDesktopMB;
}

function makeBlob(mb) {
  var chunk = new Uint8Array(1048576);
  if (self.crypto && self.crypto.getRandomValues) {
    for (var o = 0; o < chunk.length; o += 65536) self.crypto.getRandomValues(chunk.subarray(o, o + 65536));
  }
  var parts = [];
  for (var i = 0; i < mb; i++) parts.push(chunk);
  // An empty MIME type keeps cross-origin POSTs simple and avoids CORS preflights.
  return new Blob(parts);
}

async function upload(s, signal) {
  var u = urls(s).ul, blob = makeBlob(uploadChunkMB());
  var sent = 0, graced = 0, graceDone = false, graceStart = 0;
  var start = performance.now(), running = true, xhrs = [];

  function loop() {
    return new Promise(function (done) {
      function next() {
        if (!running) return done();
        var xhr = new XMLHttpRequest();
        xhrs.push(xhr);
        var prev = 0;
        xhr.open('POST', nocache(u), true);
        xhr.upload.onprogress = function (e) {
          if (!running) return;
          var d = e.loaded - prev; prev = e.loaded;
          if (!isFinite(d) || d <= 0) return;
          sent += d;
          if (graceDone) graced += d;
        };
        xhr.onloadend = function () {
          xhrs = xhrs.filter(function (x) { return x !== xhr; });
          if (!running) { done(); return; }
          // Avoid a tight retry loop when a backend or its CORS policy is unavailable.
          if (xhr.status === 0) setTimeout(next, 200);
          else next();
        };
        xhr.send(blob);
      }
      next();
    });
  }

  for (var i = 0; i < CFG.ulStreams; i++) {
    loop();
    await wait(100, signal);
    if (signal && signal.aborted) break;
  }

  var timer = setInterval(function () {
    var el = (performance.now() - start) / 1000;
    if (!graceDone && el >= CFG.graceUl) { graceDone = true; graced = 0; graceStart = performance.now(); }
    if (graceDone) {
      var live = mbps(graced, (performance.now() - graceStart) / 1000);
      setLive('Upload', live);
      $('ulVal').textContent = fmt(live);
    }
    setProgress(57.5 + Math.min(1, el / CFG.ulSeconds) * 42.5);
  }, 150);

  await wait(Math.max(0, CFG.ulSeconds * 1000 - (performance.now() - start)), signal);
  var end = performance.now();
  running = false;
  clearInterval(timer);
  xhrs.forEach(function (x) { try { x.abort(); } catch (e) {} });
  if (signal && signal.aborted) throw new Error('aborted');
  var measuredSeconds = graceDone ? (end - graceStart) / 1000 : 0;
  var speed = mbps(graced, measuredSeconds);
  if (!(speed > 0)) speed = mbps(sent, (end - start) / 1000);
  if (!(speed > 0)) throw new Error('upload failed');
  return speed;
}

/* ---------- client info ---------- */
async function clientInfo(s, signal, token) {
  try {
    var r = await timedFetch(nocache(urls(s).ip), { cache: 'no-store', mode: 'cors' }, 5000, signal);
    if (!r.ok) return;
    var j = await r.json();
    if (token !== runId || (signal && signal.aborted)) return;
    if (s.type === 'cloudflare') {
      var colo = j.colo || {};
      $('ipVal').textContent = j.clientIp || '--';
      $('ispVal').textContent = [j.asOrganization, j.country].filter(Boolean).join(' · ') || '--';
      if (colo.city) $('serverGeo').textContent = 'Edge: ' + colo.city + (colo.iata ? ' (' + colo.iata + ')' : '');
    } else {
      var text = j.processedString || j.ip || '';
      var divider = text.indexOf(' - ');
      $('ipVal').textContent = (divider > -1 ? text.slice(0, divider) : text) || '--';
      $('ispVal').textContent = (divider > -1 ? text.slice(divider + 3) : j.isp) || '--';
    }
  } catch (e) { /* client information is optional */ }
}

/* ---------- server selection ---------- */
function fillServers() {
  var sel = $('serverSel');
  sel.innerHTML = '<option value="auto">Auto (best ping)</option>';
  SERVERS.forEach(function (s, i) {
    var o = document.createElement('option');
    o.value = i; o.textContent = s.name;
    sel.appendChild(o);
  });
}

async function probe(s, signal) {
  var u = urls(s).ping;
  try {
    // Warm up DNS/TLS first so selection reflects network latency, not handshake cost.
    var warm = await timedFetch(nocache(u), { cache: 'no-store', mode: 'cors' }, CFG.probeTimeout, signal);
    if (!warm.ok) return Infinity;
    await warm.arrayBuffer();

    var t = performance.now();
    var r = await timedFetch(nocache(u), { cache: 'no-store', mode: 'cors' }, CFG.probeTimeout, signal);
    if (!r.ok) return Infinity;
    await r.arrayBuffer();
    return performance.now() - t;
  } catch (e) { return Infinity; }
}

async function pickServer(signal) {
  var list = SERVERS.filter(function (s) { return AUTO_CANDIDATES.indexOf(s.name) > -1; });
  var times = await Promise.all(list.map(function (s) { return probe(s, signal); }));
  var best = null, bt = Infinity;
  times.forEach(function (t, i) { if (t < bt) { bt = t; best = list[i]; } });
  return best || SERVERS[0];
}

/* ---------- runner ---------- */
async function run() {
  if (state === 'running') { stop(); return; }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    result = { ping: 0, jitter: 0, dl: 0, ul: 0 };
    server = null;
    $('shareRow').hidden = true;
    ['pingVal', 'jitVal', 'dlVal', 'ulVal'].forEach(function (id) { $(id).textContent = '--'; });
    $('ipVal').textContent = '--'; $('ispVal').textContent = '--'; $('serverGeo').textContent = '';
    $('serverName').textContent = 'No internet connection';
    setProgress(0);
    setLive('Failed', 0);
    return;
  }

  state = 'running';
  abort = new AbortController();
  var sig = abort.signal;
  var token = ++runId;
  var completed = false;

  result = { ping: 0, jitter: 0, dl: 0, ul: 0 };
  server = null;
  $('btn').textContent = 'Stop';
  $('btn').classList.add('stop');
  $('testCard').setAttribute('aria-busy', 'true');
  $('serverSel').disabled = true;
  $('shareRow').hidden = true;
  ['pingVal', 'jitVal', 'dlVal', 'ulVal'].forEach(function (id) { $(id).textContent = '--'; });
  $('ipVal').textContent = '--'; $('ispVal').textContent = '--'; $('serverGeo').textContent = '';
  setProgress(0);
  setLive('Connecting', 0);

  try {
    var sel = $('serverSel').value;
    $('serverName').textContent = sel === 'auto' ? 'Finding best server…' : (SERVERS[+sel] || {}).name || '--';
    server = sel === 'auto' ? await pickServer(sig) : SERVERS[+sel];
    if (!server || sig.aborted || token !== runId) throw new Error('aborted');
    $('serverName').textContent = server.name;
    setProgress(5);

    clientInfo(server, sig, token);

    setLive('Ping', 0);
    var p = await ping(server, CFG.pingCount, sig, function (progress) {
      if (token === runId) setProgress(5 + progress * 10);
    });
    result.ping = p.ping; result.jitter = p.jitter;
    $('pingVal').textContent = p.ping.toFixed(1);
    $('jitVal').textContent = p.jitter.toFixed(1);
    setProgress(15);

    setLive('Download', 0);
    result.dl = await download(server, sig);
    $('dlVal').textContent = fmt(result.dl);
    setProgress(57.5);

    setLive('Upload', 0);
    result.ul = await upload(server, sig);
    $('ulVal').textContent = fmt(result.ul);

    setLive('Complete', result.dl);
    setProgress(100);
    $('shareRow').hidden = false;
    completed = true;
  } catch (e) {
    if (token !== runId) return;
    if (!sig.aborted) {
      setLive('Failed', 0);
      $('serverName').textContent = 'Server unavailable — choose another';
      if (typeof console !== 'undefined' && console.warn) console.warn('Speed test failed:', e);
    }
  }
  if (token === runId) finish(completed);
}

function stop() {
  if (state !== 'running') return;
  runId++;
  if (abort) abort.abort();
  abort = null;
  setLive('Stopped', 0);
  finish(false);
}

function finish(keepProgress) {
  state = 'idle';
  abort = null;
  $('btn').textContent = 'Start';
  $('btn').classList.remove('stop');
  $('testCard').setAttribute('aria-busy', 'false');
  $('serverSel').disabled = false;
  if (!keepProgress) setProgress(0);
}

function shareText() {
  return 'Down ' + fmt(result.dl) + ' Mbps · Up ' + fmt(result.ul) + ' Mbps · Ping ' +
    result.ping.toFixed(1) + ' ms · Jitter ' + result.jitter.toFixed(1) + ' ms · ' +
    (server ? server.name : '');
}

fillServers();
$('btn').addEventListener('click', run);
$('serverSel').addEventListener('change', function () {
  if (state === 'running') return;
  var selected = this.value === 'auto' ? null : SERVERS[+this.value];
  $('serverName').textContent = selected ? selected.name : 'Auto';
  $('serverGeo').textContent = '';
});
$('copyBtn').addEventListener('click', function () {
  var t = shareText();
  var copied = navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(t) : Promise.reject();
  copied.then(function () {
    $('copyLabel').textContent = 'Copied';
    setTimeout(function () { $('copyLabel').textContent = 'Copy result'; }, 1500);
  }).catch(function () { window.prompt('Result', t); });
});
document.addEventListener('visibilitychange', function () {
  // Background-tab timer throttling can make bandwidth results inaccurate.
  if (document.hidden && state === 'running') stop();
});
