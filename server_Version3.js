// server.js
// Single-file simple search proxy (no npm installs).
// - Serves embedded index.html at /
// - Proxies /search, /proxy, /formproxy to upstream sites (DuckDuckGo Lite used for search examples).
// - Basic in-memory rate limiting.
// Usage: node server.js
//
// NOTE: You still must have Node.js installed. This file requires no other installs.

const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const querystring = require('querystring');
const PORT = process.env.PORT || 3000;
const USER_AGENT = 'simple-search-proxy/1.0';
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60;

// Embedded UI (index.html) — includes the "bypass" white overlay behavior.
const PUBLIC_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Simple Search Proxy</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    :root { --bg: #ffffff; --muted: #555; --maxw: 640px; }
    html,body { height:100%; margin:0; font-family: system-ui, Arial, sans-serif; background:var(--bg); }
    main { padding: 2rem; display:flex; flex-direction:column; align-items:stretch; gap:1rem; max-width:var(--maxw); margin:0 auto; }
    form { display:flex; gap:8px; }
    input[type="text"]{flex:1;padding:8px;border:1px solid #ccc;border-radius:4px}
    button{padding:8px 12px;border-radius:4px}
    .notice { color:var(--muted); font-size:0.9rem }
    .startup-overlay {
      position: fixed; inset: 0; background: #fff; z-index: 9999;
      display: flex; align-items: center; justify-content: center;
      transition: opacity 300ms ease, visibility 300ms ease;
    }
    .startup-overlay.hidden { opacity: 0; visibility: hidden; pointer-events: none; }
    .overlay-input {
      width: 1px; height: 1px; opacity: 0; border: none; outline: none;
      position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
    }
    .hint { position: fixed; bottom: 12px; right: 12px; background: rgba(0,0,0,0.6); color: #fff;
      padding: 6px 10px; border-radius: 6px; font-size: 12px; display: none; z-index:10000; }
    .hint.visible { display:block; }
  </style>
</head>
<body>
  <div id="startupOverlay" class="startup-overlay" aria-hidden="false" role="dialog" aria-label="Startup overlay">
    <input id="overlayInput" class="overlay-input" type="text"
           autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
           aria-label="Type passphrase to continue" />
  </div>

  <div id="hint" class="hint" aria-hidden="true">Type "bypass" to continue</div>

  <main>
    <h1>Simple Search Proxy (edu)</h1>

    <form action="/search" method="get" target="_self">
      <input name="q" type="text" placeholder="Search query" required />
      <button type="submit">Search</button>
    </form>

    <p class="notice">
      This is a minimal educational proxy. Do not use it for illegal activities. If you plan to run this publicly, add authentication, stricter rate-limiting, logging, and legal terms.
    </p>
  </main>

  <script>
    (function () {
      const REQUIRED_PHRASE = 'bypass';
      const overlay = document.getElementById('startupOverlay');
      const input = document.getElementById('overlayInput');
      const hint = document.getElementById('hint');
      const STORAGE_KEY = 'simple_search_proxy_bypassed_v1';

      function hideOverlay() {
        overlay.classList.add('hidden');
        overlay.setAttribute('aria-hidden','true');
        hint.setAttribute('aria-hidden','true');
        setTimeout(() => {
          if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }, 350);
      }

      try {
        if (sessionStorage.getItem(STORAGE_KEY) === 'true') {
          hideOverlay();
          return;
        }
      } catch (e) { /* ignore storage issues */ }

      function tryFocusInput() {
        try { input.focus({ preventScroll: true }); } catch (e) { try { input.focus(); } catch (e2) {} }
      }

      if (document.readyState === 'complete' || document.readyState === 'interactive') {
        tryFocusInput();
      } else {
        document.addEventListener('DOMContentLoaded', tryFocusInput, { once: true });
      }

      input.addEventListener('input', () => {
        if (input.value === REQUIRED_PHRASE) {
          try { sessionStorage.setItem(STORAGE_KEY, 'true'); } catch (e) {}
          input.value = '';
          hideOverlay();
        }
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && input.value === REQUIRED_PHRASE) {
          e.preventDefault();
          try { sessionStorage.setItem(STORAGE_KEY, 'true'); } catch (e) {}
          input.value = '';
          hideOverlay();
        }
      });

      window.addEventListener('keydown', (e) => {
        if (overlay.classList.contains('hidden')) return;
        if (e.key === '?' || e.key === '/') {
          e.preventDefault();
          hint.classList.add('visible');
          hint.setAttribute('aria-hidden','false');
          setTimeout(() => {
            hint.classList.remove('visible');
            hint.setAttribute('aria-hidden','true');
          }, 4000);
        }
      });

      overlay.addEventListener('click', tryFocusInput);
    })();
  </script>
</body>
</html>`;

// Rate limiting map: ip => timestamps
const rateMap = new Map();
function rateLimitCheck(ip) {
  const now = Date.now();
  const arr = rateMap.get(ip) || [];
  const filtered = arr.filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
  filtered.push(now);
  rateMap.set(ip, filtered);
  return filtered.length <= RATE_LIMIT_MAX;
}
function isHttpUrl(s) {
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; } catch(e){ return false; }
}

// Simple HTML rewriting: remove <script>, rewrite absolute href/src/form actions to proxy endpoints.
// Lightweight regex approach — not perfect but works for many simple pages.
function rewriteHtml(baseOrigin, html) {
  if (!html) return html;
  html = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  html = html.replace(/href=(["'])(https?:\/\/[^"'>\s]+)\1/gi, (m, q, link) => `href=${q}/proxy?url=${encodeURIComponent(link)}${q}`);
  html = html.replace(/src=(["'])(https?:\/\/[^"'>\s]+)\1/gi, (m, q, link) => `src=${q}/proxy?url=${encodeURIComponent(link)}${q}`);
  html = html.replace(/<form\b([^>]*?)action=(["'])(https?:\/\/[^"'>\s]+)\2/gi, (m, attrs, q, actionUrl) => `<form${attrs}action=${q}/formproxy?url=${encodeURIComponent(actionUrl)}${q}`);
  html = html.replace(/<form\b([^>]*?)action=([^>\s]+)/gi, (m, attrs, actionVal) => {
    const cleaned = actionVal.replace(/['"]/g, '');
    if (isHttpUrl(cleaned)) return `<form${attrs}action="/formproxy?url=${encodeURIComponent(cleaned)}"`;
    return m;
  });
  return html;
}

function proxyRequest(targetUrl, method, headers, bodyBuffer, clientReq, clientRes) {
  let parsed;
  try { parsed = new URL(targetUrl); } catch (e) {
    clientRes.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    clientRes.end('Invalid target URL');
    return;
  }
  const options = {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + (parsed.search || ''),
    method: method,
    headers: Object.assign({
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }, headers || {})
  };
  delete options.headers['cookie'];
  delete options.headers['Cookie'];
  delete options.headers['x-forwarded-for'];

  const lib = parsed.protocol === 'https:' ? https : http;
  const upstream = lib.request(options, (upRes) => {
    const contentType = (upRes.headers['content-type'] || '').toLowerCase();
    if (contentType.includes('text/html')) {
      const chunks = [];
      upRes.on('data', c => chunks.push(c));
      upRes.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const body = buffer.toString('utf8');
        const rewritten = rewriteHtml(parsed.origin, body);
        clientRes.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        clientRes.end(rewritten, 'utf8');
      });
    } else {
      const headersOut = Object.assign({}, upRes.headers);
      delete headersOut['set-cookie'];
      delete headersOut['Set-Cookie'];
      headersOut['Cache-Control'] = 'no-store';
      clientRes.writeHead(upRes.statusCode || 200, headersOut);
      upRes.pipe(clientRes);
    }
  });

  upstream.on('error', err => {
    console.error('Upstream error:', err && err.message);
    if (!clientRes.headersSent) clientRes.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    clientRes.end('Bad gateway');
  });

  if (bodyBuffer && bodyBuffer.length) upstream.write(bodyBuffer);
  upstream.end();
}

function collectRequestBody(req, cb) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => cb(null, Buffer.concat(chunks)));
  req.on('error', err => cb(err));
}

const server = http.createServer((req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (!rateLimitCheck(ip)) {
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Too many requests');
      return;
    }
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname || '/';

    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(PUBLIC_HTML, 'utf8');
      return;
    }

    if (pathname === '/search' && req.method === 'GET') {
      const q = parsedUrl.query && parsedUrl.query.q ? String(parsedUrl.query.q) : '';
      if (!q) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Missing query parameter q'); return; }
      const target = 'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(q);
      proxyRequest(target, 'GET', {}, null, req, res);
      return;
    }

    if (pathname === '/proxy' && req.method === 'GET') {
      const target = parsedUrl.query && parsedUrl.query.url ? parsedUrl.query.url : '';
      if (!target || !isHttpUrl(target)) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Missing or invalid url parameter'); return; }
      proxyRequest(target, 'GET', {}, null, req, res);
      return;
    }

    if (pathname === '/formproxy') {
      const target = parsedUrl.query && parsedUrl.query.url ? parsedUrl.query.url : '';
      if (!target || !isHttpUrl(target)) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Missing or invalid url parameter'); return; }
      if (req.method === 'GET') {
        const copy = Object.assign({}, parsedUrl.query); delete copy.url;
        const qstr = querystring.stringify(copy);
        const qs = qstr ? (target + (target.includes('?') ? '&' : '?') + qstr) : target;
        proxyRequest(qs, 'GET', {}, null, req, res);
        return;
      }
      if (req.method === 'POST') {
        collectRequestBody(req, (err, bodyBuffer) => {
          if (err) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Server error reading request'); return; }
          const headers = { 'Content-Type': req.headers['content-type'] || 'application/x-www-form-urlencoded' };
          proxyRequest(target, 'POST', headers, bodyBuffer, req, res);
        });
        return;
      }
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Method not allowed'); return;
    }

    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('ok'); return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (e) {
    console.error('Unexpected error:', e && e.stack);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal server error');
  }
});

server.listen(PORT, () => {
  console.log(`Simple search proxy listening on http://localhost:${PORT}`);
});