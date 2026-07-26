# Wifi Checker

Open source internet speed test in the browser. Download, upload, ping, jitter — no backend, no build step.

## Run

Open `index.html`, or host the folder on GitHub Pages / Netlify / Vercel.

## Servers

- **Cloudflare** — `speed.cloudflare.com` (`__down`, `__up`, `meta`), anycast global edge.
- **LibreSpeed** — 40+ public backends (`garbage.php`, `empty.php`, `getIP.php` with `cors=true`), from the [LibreSpeed server list](https://librespeed.org/backend-servers/servers.php).

`Auto` probes a spread of candidates and picks the lowest ping. Any server can be chosen manually from the dropdown.

## Method

| Phase | How |
| --- | --- |
| Ping / jitter | 10 requests, first discarded; ping = min RTT (Performance API when available), jitter = mean absolute delta |
| Download | 6 parallel streams, 10 s, 1.5 s grace before measuring |
| Upload | 3 parallel XHR streams, 10 s, 2.5 s grace |

Throughput uses a 1.06 overhead factor to account for TCP/IP + TLS framing (LibreSpeed default).

Tuning lives in `CFG` at the top of `app.js`; server list in `servers.js`.

## Files

```
index.html   markup
style.css    styles
app.js       test engine
servers.js   server list
```

## License

MIT. Server list adapted from LibreSpeed (LGPLv3).
