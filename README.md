# Wifi Checker

Open source internet speed test in the browser. Download, upload, ping, jitter — no backend, no build step.

## Run

Open `index.html`, or host the folder on GitHub Pages / Netlify / Vercel.

## Servers

- **Cloudflare** — `speed.cloudflare.com` (`__down`, `__up`, `meta`), anycast global edge.
- **LibreSpeed** — 40+ public backends (`garbage.php`, `empty.php`, `getIP.php` with `cors=true`), from the [LibreSpeed server list](https://librespeed.org/backend-servers/servers.php).

`Auto` probes a geographically distributed shortlist, warms each connection, and picks the lowest-latency responsive server. Any server can be chosen manually from the dropdown.

## Method

| Phase | How |
| --- | --- |
| Ping / jitter | Up to 10 successful requests (minimum 4), first discarded; ping = min RTT (Performance API when available), jitter = mean absolute delta in collection order |
| Download | 6 parallel streams, 10 s, 1.5 s grace before measuring, 100 MB streaming requests canceled at phase end |
| Upload | 3 parallel XHR streams, 10 s (up to 20 s until enough requests are acknowledged), 2.5 s grace; payload auto-scales from 256 KB toward ~1.2 s per request (cap 64 MB desktop / 16 MB mobile) |

Throughput uses a 1.06 overhead factor to account for TCP/IP + TLS framing (LibreSpeed default). Requests have availability timeouts, failed backends stop cleanly, and a test is canceled if the tab is backgrounded because browser timer throttling can distort results.

**Upload accounting.** `xhr.upload.onprogress` reports bytes accepted by the OS/TLS socket send buffer, not bytes that reached the server. A payload small enough to fit in that buffer is reported as "uploaded" almost instantly, so counting progress bytes measures how fast the kernel buffer fills and overstates slow links badly. Upload throughput is therefore derived only from requests the server actually acknowledged (HTTP 2xx): each stream sends serially, so its bytes are divided by the span from its first counted request to its last acknowledgement, and the per-stream rates are summed. Progress events are still used for the live readout until the first acknowledgement lands. Payload size adapts to the measured rate so slow links complete whole requests inside the window and fast links avoid per-request overhead.

Tuning lives in `CFG` at the top of `app.js`; server list in `servers.js`.

## Tests

Run the dependency-free smoke tests with Node.js:

```bash
node --test tests/smoke.test.js
```

The suite checks UI initialization, server catalog integrity, bandwidth math, a complete mocked test, offline/stop race handling, upload payload behavior (including sub-megabyte payloads), order-correct jitter calculation, and two upload-accuracy regressions: that speed comes from acknowledged requests rather than socket-buffer progress events, and that a backend which never acknowledges an upload fails cleanly instead of reporting a fabricated speed.

## Files

```
index.html   markup
style.css    styles
app.js       test engine
servers.js   server list
tests/       dependency-free smoke tests
```

## License

MIT. Server list adapted from LibreSpeed (LGPLv3).
