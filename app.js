/* Wifi Checker - speed test engine
   Backends: Cloudflare (__down/__up/meta) + LibreSpeed public servers (garbage.php/empty.php). */

var CFG = {
  pingCount: 10,
  dlSeconds: 10,
  ulSeconds: 10,
  graceDl: 1.5,
  graceUl: 2.5,
  dlStreams: 6,
  ulStreams: 3,
  chunkMB: 25,          // per download request
  ulChunkMB: 8,         // per upload request
  overhead: 1.06        // TCP/IP + TLS overhead compensation (LibreSpeed default)
};

var $ = function (id) { return document.getElementById(id); };
var state = 'idle';
var abort = null;
var server = null;
var result = { ping: 0, jitter: 0, dl: 0, ul: 0 };

/* ---------- helpers ---------- */
function sep(u) { return u.indexOf('?') > -1 ? '&' : '?'; }
function join(base, path) { return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, ''); }
function nocache(u) { return u + sep(u) + 'r=' + Math.random(); }

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
    var t = setTimeout(done, ms);
    function done() { clearTimeout(t); if (signal) signal.removeEventListener('abort', done); res(); }
    if (signal) signal.addEventListener('abort', done);
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
  gauge(speed);
}

/* ---------- ping ---------- */
async function ping(s, count, signal) {
  var u = urls(s).ping, samples = [];
  for (var i = 0; i < count; i++) {
    var t = performance.now();
    try {
      var r = await fetch(nocache(u), { cache: 'no-store', signal: signal, mode: 'cors' });
      await r.arrayBuffer();
      var rtt = performance.now() - t;
      var e = performance.getEntriesByName ? performance.getEntriesByName(r.url) : [];
      var last = e && e.length ? e[e.length - 1] : null;
      if (last && last.responseStart > 0 && last.requestStart > 0) {
        var precise = last.responseStart - last.requestStart;
        if (precise > 0 && precise < rtt) rtt = precise;
      }
      if (i > 0) samples.push(rtt);          // first request = warm-up
    } catch (err) {
      if (signal && signal.aborted) throw err;
    }
  }
  if (!samples.length) throw new Error('ping failed');
  samples.sort(function (a, b) { return a - b; });
  var min = samples[0], jit = 0;
  for (var k = 1; k < samples.length; k++) jit += Math.abs(samples[k] - samples[k - 1]);
  return { ping: min, jitter: samples.length > 1 ? jit / (samples.length - 1) : 0 };
}

/* ---------- download ---------- */
async function download(s, signal) {
  var u = urls(s).dl, bytes = 0, graced = 0, start = performance.now(), graceDone = false;
  var running = true, live = 0;

  function loop() {
    return (async function () {
      while (running) {
        try {
          var res = await fetch(nocache(u), { cache: 'no-store', signal: signal, mode: 'cors' });
          if (!res.ok || !res.body) throw new Error('bad response');
          var reader = res.body.getReader();
          while (running) {
            var c = await reader.read();
            if (c.done) break;
            bytes += c.value.length;
            if (graceDone) graced += c.value.length;
          }
          try { reader.cancel(); } catch (e) {}
        } catch (e) {
          if (signal && signal.aborted) return;
          await wait(200, signal);
        }
      }
    })();
  }

  for (var i = 0; i < CFG.dlStreams; i++) {
    loop();
    await wait(60, signal);
  }

  var graceStart = 0;
  var timer = setInterval(function () {
    var el = (performance.now() - start) / 1000;
    if (!graceDone && el >= CFG.graceDl) { graceDone = true; graced = 0; graceStart = performance.now(); }
    if (graceDone) {
      live = mbps(graced, (performance.now() - graceStart) / 1000);
      setLive('Download', live);
      $('dlVal').textContent = fmt(live);
      $('bar').style.width = Math.min(100, el / CFG.dlSeconds * 100) + '%';
    }
  }, 150);

  await wait(CFG.dlSeconds * 1000, signal);
  running = false;
  clearInterval(timer);
  if (signal && signal.aborted) throw new Error('aborted');
  var speed = mbps(graced, (performance.now() - graceStart) / 1000);
  return speed > 0 ? speed : mbps(bytes, (performance.now() - start) / 1000);
}

/* ---------- upload ---------- */
function makeBlob(mb) {
  var chunk = new Uint8Array(1048576);
  if (self.crypto && self.crypto.getRandomValues) {
    for (var o = 0; o < chunk.length; o += 65536) self.crypto.getRandomValues(chunk.subarray(o, o + 65536));
  }
  var parts = [];
  for (var i = 0; i < mb; i++) parts.push(chunk);
  return new Blob(parts, { type: 'application/octet-stream' });
}

async function upload(s, signal) {
  var u = urls(s).ul, blob = makeBlob(CFG.ulChunkMB);
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
        try { xhr.setRequestHeader('Content-Type', 'application/octet-stream'); } catch (e) {}
        xhr.upload.onprogress = function (e) {
          var d = e.loaded - prev; prev = e.loaded;
          sent += d;
          if (graceDone) graced += d;
        };
        xhr.onloadend = function () {
          xhrs = xhrs.filter(function (x) { return x !== xhr; });
          running ? next() : done();
        };
        xhr.send(blob);
      }
      next();
    });
  }

  for (var i = 0; i < CFG.ulStreams; i++) {
    loop();
    await wait(100, signal);
  }

  var timer = setInterval(function () {
    var el = (performance.now() - start) / 1000;
    if (!graceDone && el >= CFG.graceUl) { graceDone = true; graced = 0; graceStart = performance.now(); }
    if (graceDone) {
      var live = mbps(graced, (performance.now() - graceStart) / 1000);
      setLive('Upload', live);
      $('ulVal').textContent = fmt(live);
      $('bar').style.width = Math.min(100, el / CFG.ulSeconds * 100) + '%';
    }
  }, 150);

  await wait(CFG.ulSeconds * 1000, signal);
  running = false;
  clearInterval(timer);
  xhrs.forEach(function (x) { try { x.abort(); } catch (e) {} });
  if (signal && signal.aborted) throw new Error('aborted');
  var speed = mbps(graced, (performance.now() - graceStart) / 1000);
  return speed > 0 ? speed : mbps(sent, (performance.now() - start) / 1000);
}

/* ---------- client info ---------- */
async function clientInfo(s, signal) {
  try {
    var r = await fetch(nocache(urls(s).ip), { cache: 'no-store', signal: signal, mode: 'cors' });
    var j = await r.json();
    if (s.type === 'cloudflare') {
      var colo = j.colo || {};
      $('ipVal').textContent = j.clientIp || '--';
      $('ispVal').textContent = [j.asOrganization, j.country].filter(Boolean).join(' · ') || '--';
      if (colo.city) $('serverGeo').textContent = 'Edge: ' + colo.city + ' (' + colo.iata + ')';
    } else {
      var p = (j.processedString || '').split(' - ');
      $('ipVal').textContent = p[0] || '--';
      $('ispVal').textContent = p[1] || '--';
    }
  } catch (e) { /* optional */ }
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

async function probe(s) {
  var t = performance.now();
  var ctl = new AbortController();
  var to = setTimeout(function () { ctl.abort(); }, 3000);
  try {
    var r = await fetch(nocache(urls(s).ping), { cache: 'no-store', signal: ctl.signal, mode: 'cors' });
    await r.arrayBuffer();
    clearTimeout(to);
    return performance.now() - t;
  } catch (e) { clearTimeout(to); return Infinity; }
}

async function pickServer() {
  var list = SERVERS.filter(function (s) { return AUTO_CANDIDATES.indexOf(s.name) > -1; });
  var times = await Promise.all(list.map(probe));
  var best = null, bt = Infinity;
  times.forEach(function (t, i) { if (t < bt) { bt = t; best = list[i]; } });
  return best || SERVERS[0];
}

/* ---------- runner ---------- */
async function run() {
  if (state === 'running') { stop(); return; }
  state = 'running';
  abort = new AbortController();
  var sig = abort.signal;

  $('btn').textContent = 'Stop';
  $('btn').classList.add('stop');
  $('serverSel').disabled = true;
  ['pingVal', 'jitVal', 'dlVal', 'ulVal'].forEach(function (id) { $(id).textContent = '--'; });
  $('ipVal').textContent = '--'; $('ispVal').textContent = '--'; $('serverGeo').textContent = '';
  $('bar').style.width = '0%';
  setLive('Connecting', 0);

  try {
    var sel = $('serverSel').value;
    server = sel === 'auto' ? await pickServer() : SERVERS[+sel];
    $('serverName').textContent = server.name;

    clientInfo(server, sig);

    setLive('Ping', 0);
    var p = await ping(server, CFG.pingCount, sig);
    result.ping = p.ping; result.jitter = p.jitter;
    $('pingVal').textContent = p.ping.toFixed(1);
    $('jitVal').textContent = p.jitter.toFixed(1);

    result.dl = await download(server, sig);
    $('dlVal').textContent = fmt(result.dl);

    result.ul = await upload(server, sig);
    $('ulVal').textContent = fmt(result.ul);

    setLive('Download', result.dl);
    $('bar').style.width = '100%';
    $('shareRow').hidden = false;
  } catch (e) {
    if (!sig.aborted) { setLive('Failed', 0); $('serverName').textContent = 'Server unreachable — pick another'; }
  }
  finish();
}

function stop() {
  if (abort) abort.abort();
  setLive('Stopped', 0);
  finish();
}

function finish() {
  state = 'idle';
  $('btn').textContent = 'Start';
  $('btn').classList.remove('stop');
  $('serverSel').disabled = false;
  $('bar').style.width = '0%';
}

function shareText() {
  return 'Down ' + fmt(result.dl) + ' Mbps · Up ' + fmt(result.ul) + ' Mbps · Ping ' +
    result.ping.toFixed(1) + ' ms · Jitter ' + result.jitter.toFixed(1) + ' ms · ' +
    (server ? server.name : '');
}

fillServers();
$('btn').addEventListener('click', run);
$('copyBtn').addEventListener('click', function () {
  var t = shareText();
  (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () {
    $('copyBtn').textContent = 'Copied';
    setTimeout(function () { $('copyBtn').textContent = 'Copy result'; }, 1500);
  }).catch(function () { window.prompt('Result', t); });
});
