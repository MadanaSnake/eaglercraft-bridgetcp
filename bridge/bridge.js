const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const zlib = require('zlib');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');

// --- Minimal Zero-Dependency RFC 6455 WebSocket Server ---
function createWebSocketServer(httpServer) {
  const wss = new EventEmitter();
  const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

  const encodeFrame = (opcode, payload) => {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
  };

  httpServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    const ws = new EventEmitter();
    ws.OPEN = 1;
    ws.readyState = 1;
    let buf = Buffer.alloc(0);
    let fragChunks = [];
    let fragOpcode = 0;

    ws.send = (data) => {
      if (ws.readyState !== 1 || socket.destroyed) return;
      const isBuf = Buffer.isBuffer(data);
      const payload = isBuf ? data : Buffer.from(String(data), 'utf8');
      socket.write(encodeFrame(isBuf ? 0x02 : 0x01, payload));
    };

    ws.close = () => {
      if (ws.readyState !== 1) return;
      ws.readyState = 3;
      if (!socket.destroyed) {
        socket.write(encodeFrame(0x08, Buffer.alloc(0)));
        socket.end();
      }
    };

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const b0 = buf[0];
        const b1 = buf[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let payloadLen = b1 & 0x7f;
        let offset = 2;

        if (payloadLen === 126) {
          if (buf.length < 4) break;
          payloadLen = buf.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (buf.length < 10) break;
          payloadLen = Number(buf.readBigUInt64BE(2));
          offset = 10;
        }

        const maskLen = masked ? 4 : 0;
        if (buf.length < offset + maskLen + payloadLen) break;

        let payload = buf.subarray(offset + maskLen, offset + maskLen + payloadLen);
        if (masked) {
          const mask = buf.subarray(offset, offset + 4);
          payload = Buffer.from(payload);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        }
        buf = buf.subarray(offset + maskLen + payloadLen);

        if (opcode === 0x08) {
          ws.readyState = 3;
          socket.end();
          ws.emit('close');
          return;
        } else if (opcode === 0x09) {
          if (!socket.destroyed) socket.write(encodeFrame(0x0a, payload));
        } else if (opcode === 0x0a) {
          // pong
        } else {
          if (opcode !== 0x00) {
            fragOpcode = opcode;
            fragChunks = [payload];
          } else {
            fragChunks.push(payload);
          }
          if (fin) {
            const full = fragChunks.length === 1 ? fragChunks[0] : Buffer.concat(fragChunks);
            fragChunks = [];
            ws.emit('message', full, fragOpcode === 0x02);
          }
        }
      }
    });

    socket.on('close', () => {
      if (ws.readyState !== 3) {
        ws.readyState = 3;
        ws.emit('close');
      }
    });
    socket.on('error', (err) => ws.emit('error', err));

    wss.emit('connection', ws, req);
  });

  return wss;
}

// Flags (--wss) are stripped so they never shift the positional arguments.
const ARGS = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1'; // set BIND_HOST=0.0.0.0 for LAN access
const WS_PORT = parseInt(process.env.WS_PORT || ARGS[0] || '8081', 10);
let MC_HOST = process.env.MC_HOST || ARGS[1] || '127.0.0.1';
let MC_PORT = parseInt(process.env.MC_PORT || ARGS[2] || '25565', 10);
// Protocol the bridge writes into the Java handshake. The config page offers
// presets for Eaglercraft 26.3 (777), 26.2 (776), 1.12.2 (340) and 1.8.8 (47),
// plus a custom number; MC_PROTOCOL / the 4th argument only set the initial value.
let PROTOCOL_VERSION = parseInt(process.env.MC_PROTOCOL || ARGS[3] || '777', 10);

// The plain HTTP/WS listener always runs: 26.2/26.3 accept ws://, and browsers
// exempt localhost from mixed-content blocking. WSS=1 adds a second, TLS
// listener for clients that only accept wss:// (the 1.8.8/1.12.2 builds).
const USE_WSS = process.argv.includes('--wss') || /^(1|true|yes|on)$/i.test(String(process.env.WSS || ''));
const WSS_PORT = parseInt(process.env.WSS_PORT || String(WS_PORT + 1), 10);
const CERT_FILE = process.env.CERT_FILE || 'bridge-cert.pem';
const KEY_FILE = process.env.KEY_FILE || 'bridge-key.pem';

// Optional: serve an Eaglercraft build from this server at /play, so the game
// page and the WebSocket share one origin (no mixed content, one certificate).
// CLIENT_HTML is a single-file build; CLIENT_DIR is a folder with index.html
// plus its sibling payloads (classes.wasm.br, assets.epk, sounds.epk, ...).
let CLIENT_HTML = process.env.CLIENT_HTML || '';
let CLIENT_DIR = process.env.CLIENT_DIR ? path.resolve(process.env.CLIENT_DIR) : '';
let CLIENT_ENTRY = '';
if (CLIENT_HTML && !CLIENT_DIR) {
  CLIENT_DIR = path.dirname(path.resolve(CLIENT_HTML));
  CLIENT_ENTRY = path.basename(CLIENT_HTML);
}

const CLIENT_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.br': 'application/octet-stream',
  '.epk': 'application/octet-stream',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// Streams one file out of CLIENT_DIR. Returns true when it has taken over the
// response, false when the path doesn't resolve to a regular file inside it.
function serveClientFile(reqUrl, res) {
  let rel;
  try {
    rel = decodeURIComponent((reqUrl.split('?')[0] || '/'));
  } catch {
    return false;
  }
  if (rel === '/play' || rel === '/play/' || rel === '/play.html') rel = '/' + (CLIENT_ENTRY || 'index.html');
  else if (rel.startsWith('/play/')) rel = rel.slice('/play'.length);

  let full = path.resolve(CLIENT_DIR, '.' + rel);
  if (!full.startsWith(CLIENT_DIR + path.sep)) return false;

  let stat;
  try {
    stat = fs.statSync(full);
    // A directory serves its index.html, so /play and /26.2/ both work.
    if (stat.isDirectory()) {
      full = path.join(full, 'index.html');
      stat = fs.statSync(full);
    }
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const type = CLIENT_MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': path.extname(full).toLowerCase() === '.html' ? 'no-store' : 'public, max-age=3600',
  });
  const stream = fs.createReadStream(full);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
  return true;
}

// Choosing the client at runtime means browsing this machine's filesystem, so
// it is restricted to loopback clients even when BIND_HOST opens the UI up.
function isLoopback(req) {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function expandUserPath(input) {
  let out = String(input || '').trim();
  if (out === '~' || out.startsWith('~/')) out = os.homedir() + out.slice(1);
  return path.resolve(out);
}

function sendJson(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function tryMkcert() {
  try {
    execFileSync('mkcert', [
      '-cert-file', CERT_FILE, '-key-file', KEY_FILE, 'localhost', '127.0.0.1', '::1',
    ], { stdio: 'pipe' });
    return fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE);
  } catch {
    return false;
  }
}

function loadTlsMaterial() {
  if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
    return { key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CERT_FILE) };
  }
  if (tryMkcert()) {
    console.log(`  TLS          : using mkcert certificate (${CERT_FILE})`);
    return { key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CERT_FILE) };
  }
  console.log('WSS enabled and no certificate found; generating a self-signed one...');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
      '-keyout', KEY_FILE, '-out', CERT_FILE, '-days', '3650',
      '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1',
    ], { stdio: 'pipe' });
    console.log(`  wrote ${CERT_FILE} and ${KEY_FILE}`);
    return { key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CERT_FILE) };
  } catch (err) {
    console.error('Could not create a certificate with openssl (is it installed?).');
    console.error(`Provide ${CERT_FILE} and ${KEY_FILE} yourself, or set CERT_FILE / KEY_FILE.`);
    const detail = String((err && (err.stderr || err.message)) || '').trim().split('\n')[0];
    if (detail) console.error(detail);
    process.exit(1);
  }
}

// --- VarInt helpers ---
function readVarInt(buf, offset = 0) {
  let numRead = 0;
  let result = 0;
  let read;
  do {
    if (offset + numRead >= buf.length) return null;
    read = buf[offset + numRead];
    result |= (read & 0x7f) << (7 * numRead);
    numRead++;
    if (numRead > 5) throw new Error('VarInt too big');
  } while ((read & 0x80) !== 0);
  return { value: result, length: numRead };
}

function writeVarInt(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let temp = v & 0x7f;
    v >>>= 7;
    if (v !== 0) temp |= 0x80;
    bytes.push(temp);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function writeMcString(str) {
  const strBuf = Buffer.from(str, 'utf8');
  return Buffer.concat([writeVarInt(strBuf.length), strBuf]);
}

function frameMcPacket(packetId, payload = Buffer.alloc(0), compressionThreshold = -1) {
  const idBuf = writeVarInt(packetId);
  const raw = Buffer.concat([idBuf, payload]);

  if (compressionThreshold >= 0) {
    if (raw.length >= compressionThreshold) {
      const compressed = zlib.deflateSync(raw);
      const dataLen = writeVarInt(raw.length);
      const inner = Buffer.concat([dataLen, compressed]);
      return Buffer.concat([writeVarInt(inner.length), inner]);
    } else {
      const dataLen = writeVarInt(0);
      const inner = Buffer.concat([dataLen, raw]);
      return Buffer.concat([writeVarInt(inner.length), inner]);
    }
  }
  return Buffer.concat([writeVarInt(raw.length), raw]);
}

function offlineUuid(username) {
  const md5 = crypto.createHash('md5').update('OfflinePlayer:' + username).digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  return md5;
}

const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Eaglercraft <-> Java Bridge</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; background: #12141a; color: #e6edf3; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 24px 16px; }
  .lede { font-size: 0.85rem; line-height: 1.45; color: #8b949e; margin: 8px 0 16px; }
  .lede code, footer code { color: #8b949e; background: #0d1117; padding: 1px 4px; border-radius: 4px; }
  .row { display: flex; gap: 8px; }
  .row > div { flex: 1; }
  .row > div:first-child { flex: 2; }
  .flags { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 4px; }
  .chip { font-size: 0.7rem; padding: 2px 8px; border-radius: 999px; border: 1px solid #30363d; color: #8b949e; white-space: nowrap; }
  .chip.on { color: #7ee787; border-color: #238636; }
  .chip.off { color: #d29922; border-color: #9e6a03; }
  .chip.idle { color: #6e7681; }
  .card { background: #1b1f27; border: 1px solid #30363d; border-radius: 10px; padding: 24px; width: 100%; max-width: 420px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); }
  h1 { font-size: 1.2rem; margin: 0; color: #58a6ff; }
  label { display: block; font-size: 0.85rem; color: #8b949e; margin: 12px 0 4px; }
  input, select { width: 100%; box-sizing: border-box; padding: 9px 10px; border-radius: 6px; border: 1px solid #30363d; background: #0d1117; color: #e6edf3; font-size: 0.95rem; font-family: inherit; }
  input:focus, select:focus { outline: none; border-color: #1f6feb; }
  footer { margin-top: 18px; font-size: 0.72rem; color: #6e7681; line-height: 1.5; }
  .status.err { color: #ff7b72; }
  .hint { font-size: 0.75rem; color: #8b949e; margin-top: 4px; }
  button { margin-top: 16px; width: 100%; padding: 10px; border: 0; border-radius: 6px; background: #238636; color: #fff; font-weight: 600; font-size: 0.95rem; cursor: pointer; }
  button:hover { background: #2ea043; }
  .ws-box { margin-top: 16px; padding: 10px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; font-size: 0.85rem; display: flex; justify-content: space-between; align-items: center; }
  .ws-box code { color: #7ee787; }
  .ws-box.warn { color: #d29922; }
  .ws-box.warn code { color: #d29922; }
  .copy-btn { width: auto; margin: 0; padding: 4px 10px; font-size: 0.75rem; background: #30363d; }
  .status { margin-top: 10px; font-size: 0.85rem; color: #7ee787; min-height: 1.2em; }
  button:disabled { opacity: 0.45; cursor: default; }
  button:disabled:hover { background: #30363d; }
  .modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.65); display: none; align-items: center; justify-content: center; padding: 16px; z-index: 20; }
  .modal-bg.open { display: flex; }
  .modal { background: #1b1f27; border: 1px solid #30363d; border-radius: 10px; width: 100%; max-width: 460px; padding: 16px; }
  .modal h2 { font-size: 0.95rem; margin: 0 0 8px; color: #e6edf3; font-weight: 600; }
  .crumbs { font-size: 0.72rem; color: #8b949e; word-break: break-all; margin-bottom: 8px; min-height: 1em; }
  .list { max-height: 260px; overflow: auto; border: 1px solid #30363d; border-radius: 6px; background: #0d1117; }
  .item { padding: 7px 10px; font-size: 0.85rem; cursor: pointer; border-bottom: 1px solid #161b22; }
  .item:last-child { border-bottom: 0; }
  .item:hover { background: #161b22; }
  .item.dir { color: #7ee787; }
  .item.file { color: #58a6ff; }
  .modal-actions { display: flex; gap: 8px; margin-top: 10px; }
  .modal-actions button { margin-top: 0; width: auto; flex: 1; background: #30363d; color: #e6edf3; font-weight: 500; }
  .modal-actions button:hover { background: #3d444d; }
</style>
</head>
<body>
<div class="card">
  <h1>Eaglercraft &harr; Java TCP Bridge</h1>
  <p class="lede">Relays an Eaglercraft client to a Java Minecraft server. Set the server, pick your client version, then connect the game to an address below.</p>
  <div class="flags" id="flags"></div>
  <label>Java server address and port</label>
  <div class="row">
    <div><input id="host" placeholder="play.example.net"></div>
    <div><input id="port" type="number" min="1" max="65535" placeholder="25565"></div>
  </div>
  <label>Client version / Minecraft protocol</label>
  <select id="protoPreset"></select>
  <input id="protoCustom" type="number" min="1" max="65535" placeholder="Custom protocol, e.g. 763" style="display:none;margin-top:8px;">
  <div class="hint" id="protoHint"></div>
  <div style="display:flex;gap:8px;margin-top:16px;">
    <button style="margin-top:0;" onclick="save()">Save &amp; Apply</button>
    <button style="margin-top:0;background:#1f6feb;" onclick="testPing()">Test Ping</button>
  </div>
  <div class="status" id="status"></div>
  <div class="ws-box">
    <span>26.2 / 26.3: <code id="wsUrl"></code></span>
    <button class="copy-btn" onclick="copyUrl('wsUrl')">Copy</button>
  </div>
  <div class="ws-box" id="wssBox" style="display:none;">
    <span>1.8.8 / 1.12.2: <code id="wssUrl"></code></span>
    <button class="copy-btn" onclick="copyUrl('wssUrl')">Copy</button>
  </div>
  <div class="ws-box warn" id="wssOff" style="display:none;">
    <span>1.8.8 / 1.12.2 need <code>wss://</code> — restart the bridge with <code>WSS=1</code></span>
  </div>
  <div class="ws-box" id="clientBox" style="flex-direction:column;align-items:stretch;gap:8px;">
    <span style="font-size:0.8rem;color:#8b949e;">Game page:
      <code id="clientState" style="display:inline-block;max-width:70%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom;color:#7ee787;">not set</code>
    </span>
    <div style="display:flex;gap:8px;">
      <button class="copy-btn" style="margin:0;flex:1;background:#1f6feb;" onclick="openPicker()">Choose client...</button>
      <button class="copy-btn" id="playBtn" style="margin:0;flex:1;background:#238636;" onclick="window.open('/play', '_blank')" disabled>Play</button>
    </div>
  </div>
  <footer>The Java server must run with <code>online-mode=false</code>. The plain <code>ws://</code> listener is always on; <code>wss://</code>, which the 1.8.8 and 1.12.2 clients require, only exists when the bridge is started with <code>WSS=1</code>. Browsers treat <code>127.0.0.1</code> as secure, so an https game page can still reach <code>ws://</code>.</footer>
</div>
<div class="modal-bg" id="modal">
  <div class="modal">
    <h2>Choose the Eaglercraft client</h2>
    <div class="crumbs" id="crumbs"></div>
    <div class="list" id="list"></div>
    <div class="modal-actions">
      <button onclick="upDir()">Up</button>
      <button onclick="useCurrentDir()">Use this folder</button>
      <button onclick="closePicker()">Cancel</button>
    </div>
    <div class="hint">Pick the folder that holds your builds (the fast-eaglercraft repo root, or one version folder), or a single <code>.html</code> build — its folder is served either way.</div>
  </div>
</div>
<script>
  const PRESETS = [
    { protocol: 777, label: 'Eaglercraft 26.3 (protocol 777)' },
    { protocol: 776, label: 'Eaglercraft 26.2 (protocol 776)' },
    { protocol: 340, label: 'Eaglercraft 1.12.2 (protocol 340)', needsWss: true },
    { protocol: 47, label: 'Eaglercraft 1.8.8 (protocol 47)', needsWss: true }
  ];
  const presetSelect = document.getElementById('protoPreset');
  const customInput = document.getElementById('protoCustom');
  const known = {};

  PRESETS.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = String(p.protocol);
    opt.textContent = p.label;
    presetSelect.appendChild(opt);
    known[p.protocol] = true;
  });
  const customOption = document.createElement('option');
  customOption.value = 'custom';
  customOption.textContent = 'Custom protocol...';
  presetSelect.appendChild(customOption);

  document.getElementById('protoHint').textContent =
    'Presets: 26.3 = 777, 26.2 = 776, 1.12.2 = 340, 1.8.8 = 47. ' +
    'The value goes into the Java handshake, so it has to match the client exactly.';

  function selectedProtocol() {
    if (presetSelect.value !== 'custom') return parseInt(presetSelect.value, 10);
    return parseInt(customInput.value, 10);
  }

  function setProtocol(value) {
    const protocol = parseInt(value, 10);
    if (known[protocol]) {
      presetSelect.value = String(protocol);
      customInput.style.display = 'none';
      return;
    }
    presetSelect.value = 'custom';
    customInput.style.display = 'block';
    customInput.value = Number.isFinite(protocol) ? String(protocol) : '';
  }

  // The 1.8.8 and 1.12.2 clients only speak wss://, so their presets are greyed
  // out unless the bridge was started with WSS=1.
  function applyWssState(enabled) {
    PRESETS.forEach((p) => {
      if (!p.needsWss) return;
      const opt = presetSelect.querySelector('option[value="' + p.protocol + '"]');
      if (!opt) return;
      opt.disabled = !enabled;
      opt.textContent = p.label + (enabled ? '' : ' - needs WSS=1');
    });
  }

  function renderFlags(config) {
    const box = document.getElementById('flags');
    box.textContent = '';
    [
      { text: 'ws:// ' + config.wsPort, state: 'on' },
      { text: config.wssEnabled ? 'wss:// ' + config.wssPort : 'wss:// off', state: config.wssEnabled ? 'on' : 'off' },
      { text: config.playUrl ? '/play' : '/play off', state: config.playUrl ? 'on' : 'idle' }
    ].forEach((chip) => {
      const el = document.createElement('span');
      el.className = 'chip ' + chip.state;
      el.textContent = chip.text;
      box.appendChild(el);
    });
  }

  function setStatus(text, isError) {
    const el = document.getElementById('status');
    el.textContent = text;
    el.className = isError ? 'status err' : 'status';
  }

  presetSelect.addEventListener('change', () => {
    customInput.style.display = presetSelect.value === 'custom' ? 'block' : 'none';
    if (presetSelect.value === 'custom') customInput.focus();
  });

  let wsUrl = 'ws://' + location.hostname + ':' + location.port;
  document.getElementById('wsUrl').textContent = wsUrl;
  function copyUrl(id) {
    const value = document.getElementById(id).textContent;
    navigator.clipboard.writeText(value);
    setStatus('Copied ' + value);
  }
  function loadConfig() {
    fetch('/api/config').then(r => r.json()).then(c => {
      document.getElementById('host').value = c.mcHost;
      document.getElementById('port').value = c.mcPort;
      applyWssState(c.wssEnabled);
      setProtocol(c.protocolVersion);
      wsUrl = 'ws://' + location.hostname + ':' + c.wsPort;
      document.getElementById('wsUrl').textContent = wsUrl;
      if (c.wssEnabled) {
        document.getElementById('wssUrl').textContent = 'wss://' + location.hostname + ':' + c.wssPort;
        document.getElementById('wssBox').style.display = 'flex';
      }
      document.getElementById('playBtn').disabled = !c.playUrl;
      if (!c.wssEnabled) document.getElementById('wssOff').style.display = 'flex';
      renderFlags(c);
    });
  }

  let browsePath = null;
  let browseParent = null;

  function refreshClient() {
    fetch('/api/client').then(r => r.json()).then(c => {
      const state = document.getElementById('clientState');
      const label = c.path ? (c.entry ? c.path + ' -> ' + c.entry : c.path) : 'not set';
      state.textContent = label;
      state.title = label;
      document.getElementById('playBtn').disabled = !c.playUrl;
    });
  }

  function openPicker() {
    document.getElementById('modal').classList.add('open');
    loadDir(null);
  }
  function closePicker() {
    document.getElementById('modal').classList.remove('open');
  }
  function upDir() {
    if (browseParent && browseParent !== browsePath) loadDir(browseParent);
  }
  function useCurrentDir() {
    if (browsePath) useClient(browsePath);
  }
  function joinPath(dir, name) {
    return (dir === '/' ? '' : dir) + '/' + name;
  }
  function loadDir(dir) {
    const url = '/api/browse' + (dir ? '?path=' + encodeURIComponent(dir) : '');
    fetch(url).then(r => r.json()).then(d => {
      if (d.error) { setStatus('Cannot open folder: ' + d.error, true); return; }
      browsePath = d.path;
      browseParent = d.parent;
      document.getElementById('crumbs').textContent = d.path;
      const list = document.getElementById('list');
      list.textContent = '';
      const add = (name, kind, full) => {
        const el = document.createElement('div');
        el.className = 'item ' + kind;
        el.textContent = kind === 'dir' ? name + '/' : name;
        el.addEventListener('click', () => (kind === 'dir' ? loadDir(full) : useClient(full)));
        list.appendChild(el);
      };
      d.dirs.forEach(n => add(n, 'dir', joinPath(d.path, n)));
      d.files.forEach(n => add(n, 'file', joinPath(d.path, n)));
      if (!d.dirs.length && !d.files.length) {
        const el = document.createElement('div');
        el.className = 'item';
        el.textContent = 'No folders or .html files here - go up.';
        list.appendChild(el);
      }
    }).catch(() => setStatus('Browse request failed', true));
  }
  function useClient(path) {
    fetch('/api/client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path })
    }).then(r => r.json()).then(c => {
      if (c.error) { setStatus('Cannot use it: ' + c.error, true); return; }
      closePicker();
      loadConfig();
      refreshClient();
      setStatus('Game page: ' + c.path + (c.hasIndex === false ? ' (no index.html there yet)' : ''));
    }).catch(() => setStatus('Request failed', true));
  }

  loadConfig();
  refreshClient();
  function save() {
    const protocol = selectedProtocol();
    if (!protocol) { setStatus('Pick a client version or type a protocol between 1 and 65535', true); return; }
    setStatus('Saving...');
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mcHost: document.getElementById('host').value.trim(),
        mcPort: parseInt(document.getElementById('port').value, 10),
        protocolVersion: protocol
      })
    }).then(r => r.json()).then(c => {
      if (c.error) { setStatus('Save failed: ' + c.error, true); return; }
      setStatus('Updated: ' + c.mcHost + ':' + c.mcPort + ' (protocol ' + c.protocolVersion + ')');
    }).catch(() => setStatus('Save request failed', true));
  }
  function testPing() {
    setStatus('Pinging...');
    fetch('/api/ping').then(r => r.json()).then(p => {
      setStatus(p.ok ? ('Ping to ' + p.host + ':' + p.port + ' = ' + p.pingMs + ' ms') : ('Ping failed: ' + p.error), !p.ok);
    }).catch(() => setStatus('Ping request failed', true));
  }
</script>
</body>
</html>`;

// --- HTTP + WebSocket Server ---
const requestHandler = (req, res) => {
  const playPath = req.url === '/play' || req.url === '/play.html' || req.url.startsWith('/play/');
  if (req.method === 'GET' && playPath && CLIENT_DIR) {
    if (!serveClientFile(req.url, res)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found in CLIENT_DIR: ' + req.url);
    }
    return;
  }
  if (req.method === 'GET' && CLIENT_DIR && req.url !== '/' && !req.url.startsWith('/api/') && serveClientFile(req.url, res)) {
    return;
  }
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(UI_HTML);
  } else if (req.method === 'GET' && req.url === '/play') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No client configured. Start the bridge with CLIENT_DIR=/path/to/client-folder or CLIENT_HTML=/path/to/eaglercraft.html');
  } else if (req.method === 'GET' && req.url === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      mcHost: MC_HOST,
      mcPort: MC_PORT,
      protocolVersion: PROTOCOL_VERSION,
      wsPort: WS_PORT,
      wssEnabled: USE_WSS,
      wssPort: USE_WSS ? WSS_PORT : null,
      playUrl: CLIENT_DIR ? '/play' : null,
    }));
  } else if (req.method === 'POST' && req.url === '/api/config') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const fail = (message) => {
        if (res.writableEnded) return;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      };

      let data;
      try {
        data = JSON.parse(body);
      } catch {
        return fail('Bad JSON');
      }

      const host = data.mcHost === undefined ? MC_HOST : String(data.mcHost).trim();
      const port = data.mcPort === undefined ? MC_PORT : parseInt(data.mcPort, 10);
      const protocol = data.protocolVersion === undefined
        ? PROTOCOL_VERSION
        : parseInt(data.protocolVersion, 10);

      if (!host) return fail('A server host is required');
      if (!Number.isInteger(port) || port < 1 || port > 65535) return fail('Port must be 1-65535');
      // The 0x02 handshake reply carries the protocol in two bytes, so 65535 is the ceiling.
      if (!Number.isInteger(protocol) || protocol < 1 || protocol > 65535) {
        return fail('Protocol must be 1-65535');
      }

      MC_HOST = host;
      MC_PORT = port;
      PROTOCOL_VERSION = protocol;
      console.log(`[Config] Updated target -> ${MC_HOST}:${MC_PORT} (protocol ${PROTOCOL_VERSION})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mcHost: MC_HOST, mcPort: MC_PORT, protocolVersion: PROTOCOL_VERSION }));
    });
  } else if (req.method === 'GET' && req.url === '/api/ping') {
    const start = Date.now();
    const sock = net.createConnection({ host: MC_HOST, port: MC_PORT });
    sock.setTimeout(3000);
    const done = (payload) => {
      if (!sock.destroyed) sock.destroy();
      if (!res.writableEnded) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      }
    };
    sock.on('connect', () => done({ ok: true, pingMs: Date.now() - start, host: MC_HOST, port: MC_PORT }));
    sock.on('timeout', () => done({ ok: false, error: 'Timed out (3000ms)' }));
    sock.on('error', (err) => done({ ok: false, error: err.message }));
  } else if (req.method === 'GET' && req.url === '/api/client') {
    sendJson(res, {
      kind: CLIENT_DIR ? (CLIENT_ENTRY ? 'file' : 'dir') : null,
      path: CLIENT_DIR || null,
      entry: CLIENT_ENTRY || null,
      playUrl: CLIENT_DIR ? '/play' : null,
    });
  } else if (req.method === 'POST' && req.url === '/api/client') {
    if (!isLoopback(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Picking a client is restricted to loopback clients');
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        return sendJson(res, { error: 'Bad JSON' }, 400);
      }
      const target = expandUserPath(data.path);
      fs.stat(target, (err, stat) => {
        if (err) return sendJson(res, { error: 'Cannot open ' + target }, 400);
        let kind;
        if (stat.isDirectory()) {
          kind = 'dir';
          CLIENT_DIR = target;
          CLIENT_ENTRY = '';
        } else if (stat.isFile() && /\.html?$/i.test(target)) {
          // A single-file build still lives in a folder, so serve the folder and
          // open the file: its siblings stay reachable and /play keeps working.
          kind = 'file';
          CLIENT_DIR = path.dirname(target);
          CLIENT_ENTRY = path.basename(target);
        } else {
          return sendJson(res, { error: 'Pick a folder or an .html file' }, 400);
        }
        const hasIndex = kind === 'dir' ? fs.existsSync(path.join(target, 'index.html')) : true;
        console.log(`[Client] Game page -> ${kind === 'dir' ? 'folder' : 'file'} ${target}`);
        sendJson(res, { kind, path: CLIENT_DIR, entry: CLIENT_ENTRY || null, hasIndex, playUrl: '/play' });
      });
    });
  } else if (req.method === 'GET' && req.url.startsWith('/api/browse')) {
    if (!isLoopback(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Browsing is restricted to loopback clients');
      return;
    }
    let dir;
    try {
      const requested = new URL(req.url, 'http://localhost').searchParams.get('path');
      dir = expandUserPath(requested || os.homedir());
    } catch {
      return sendJson(res, { error: 'Bad path' }, 400);
    }
    fs.readdir(dir, { withFileTypes: true }, (err, entries) => {
      if (err) return sendJson(res, { error: err.code || err.message, path: dir }, 400);
      const dirs = [];
      const files = [];
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isDirectory()) dirs.push(entry.name);
        else if (entry.isFile() && /\.html?$/i.test(entry.name)) files.push(entry.name);
      }
      dirs.sort((a, b) => a.localeCompare(b));
      files.sort((a, b) => a.localeCompare(b));
      sendJson(res, { path: dir, parent: path.dirname(dir), dirs, files });
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
};

function startListener(port, tls) {
  const server = tls
    ? https.createServer(loadTlsMaterial(), requestHandler)
    : http.createServer(requestHandler);
  const wss = createWebSocketServer(server);
  wss.on('connection', handleConnection);
  server.on('error', (err) => {
    console.error(`Cannot listen on ${BIND_HOST}:${port}: ${err.message}`);
    process.exit(1);
  });
  server.listen(port, BIND_HOST, () => {
    const scheme = tls ? 'https' : 'http';
    const label = tls ? 'Secure UI  ' : 'Config UI  ';
    console.log(`  ${label} : ${scheme}://localhost:${port}  <-- Open this in your browser!`);
  });
  return server;
}

console.log('Eaglercraft WS <-> Java TCP Bridge');
console.log(`  Target Java  : ${MC_HOST}:${MC_PORT} (protocol ${PROTOCOL_VERSION})`);
startListener(WS_PORT, false);
if (USE_WSS) startListener(WSS_PORT, true);
if (CLIENT_DIR) {
  const source = process.env.CLIENT_HTML ? 'CLIENT_HTML' : 'CLIENT_DIR';
  console.log(`  Game page    : /play (from ${source}${CLIENT_ENTRY ? ', entry ' + CLIENT_ENTRY : ''})`);
}
if (!USE_WSS) {
  console.log('  1.8.8/1.12.2 need wss:// - restart with WSS=1 to add a TLS listener');
}
console.log(`  Note: Target Java server must have online-mode=false`);

function handleConnection(ws, req) {
  const remote = req.socket.remoteAddress;
  let state = 'EAGLER_HANDSHAKE';
  let tcpSocket = null;
  let tcpBuffer = Buffer.alloc(0);
  let compressionThreshold = -1;
  let username = 'Player';

  const cleanup = () => {
    if (tcpSocket && !tcpSocket.destroyed) tcpSocket.destroy();
    if (ws.readyState === ws.OPEN) ws.close();
  };

  const connectToJavaServer = (playerName) => {
    username = playerName || 'Player';
    console.log(`[${remote}] Connecting "${username}" -> ${MC_HOST}:${MC_PORT}`);

    tcpSocket = net.createConnection({ host: MC_HOST, port: MC_PORT }, () => {
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(MC_PORT, 0);
      const handshakePayload = Buffer.concat([
        writeVarInt(PROTOCOL_VERSION),
        writeMcString(MC_HOST),
        portBuf,
        writeVarInt(2),
      ]);
      tcpSocket.write(frameMcPacket(0x00, handshakePayload));

      const loginPayload = PROTOCOL_VERSION >= 761
        ? Buffer.concat([writeMcString(username), offlineUuid(username)])
        : writeMcString(username);
      tcpSocket.write(frameMcPacket(0x00, loginPayload));
    });

    tcpSocket.on('data', (chunk) => {
      try {
      tcpBuffer = Buffer.concat([tcpBuffer, chunk]);

      while (tcpBuffer.length > 0) {
        const lenInfo = readVarInt(tcpBuffer, 0);
        if (!lenInfo) break;
        const packetLen = lenInfo.value;
        const totalLen = lenInfo.length + packetLen;
        if (tcpBuffer.length < totalLen) break;

        let packetData = tcpBuffer.subarray(lenInfo.length, totalLen);
        tcpBuffer = tcpBuffer.subarray(totalLen);

        if (compressionThreshold >= 0) {
          const dataLenInfo = readVarInt(packetData, 0);
          if (!dataLenInfo) continue;
          const uncompressedLen = dataLenInfo.value;
          const rest = packetData.subarray(dataLenInfo.length);
          packetData = uncompressedLen === 0 ? rest : zlib.inflateSync(rest);
        }

        if (state === 'MC_LOGIN') {
          const idInfo = readVarInt(packetData, 0);
          if (!idInfo) continue;
          const packetId = idInfo.value;

          if (packetId === 0x03) {
            const threshInfo = readVarInt(packetData, idInfo.length);
            if (threshInfo) {
              compressionThreshold = threshInfo.value;
              console.log(`[${username}] Compression threshold set to ${compressionThreshold}`);
            }
          } else if (packetId === 0x02) {
            state = 'PLAY';
            console.log(`[${username}] Logged in! Bridging PLAY packets.`);
            if (PROTOCOL_VERSION >= 764 && tcpSocket && !tcpSocket.destroyed) {
              tcpSocket.write(frameMcPacket(0x03, Buffer.alloc(0), compressionThreshold));
            }
            if (ws.readyState === ws.OPEN) {
              ws.send(Buffer.from([0x09]));
            }
          } else if (packetId === 0x00) {
            console.log(`[${username}] Disconnected during login by Java server.`);
            cleanup();
            return;
          } else if (packetId === 0x01) {
            console.error(`[${username}] Error: Target server has online-mode=true! Set online-mode=false in server.properties.`);
            cleanup();
            return;
          }
        } else if (state === 'PLAY') {
          if (ws.readyState === ws.OPEN) {
            ws.send(packetData);
          }
        }
      }
      } catch (err) {
        console.error(`[${username}] Bad packet from Java server: ${err.message}`);
        cleanup();
      }
    });

    tcpSocket.on('error', (err) => {
      console.error(`[${username}] TCP error: ${err.message}`);
      cleanup();
    });

    tcpSocket.on('close', () => {
      console.log(`[${username}] Java server closed connection.`);
      cleanup();
    });
  };

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      const text = data.toString('utf8').trim();
      if (text.startsWith('Accept: MOTD')) {
        ws.send(JSON.stringify({
          name: 'Eaglercraft Bridge',
          brand: 'fast-eaglercraft',
          vers: 'EaglerBridge/1.0',
          cracked: true,
          time: Date.now(),
          uuid: crypto.randomUUID(),
          type: 'motd',
          data: {
            cache: true,
            motd: [`§aEaglercraft -> Java Bridge`, `§7Target: ${MC_HOST}:${MC_PORT}`],
            icon: false,
            online: 0,
            max: 20,
            players: [],
          },
        }));
        ws.close();
      }
      return;
    }

    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length === 0) return;

    if (state === 'EAGLER_HANDSHAKE') {
      const pktId = buf[0];
      if (pktId === 0x01) {
        console.log(`[${remote}] Client 0x01 (${buf.length} bytes): ${buf.subarray(0, 16).toString('hex')}`);
        const protoHi = (PROTOCOL_VERSION >> 8) & 0xff;
        const protoLo = PROTOCOL_VERSION & 0xff;
        const brand = Buffer.from('EaglerBridge', 'utf8');
        const vers = Buffer.from('1.0', 'utf8');
        ws.send(Buffer.concat([
          Buffer.from([0x02, 0x00, 0x03, protoHi, protoLo]),
          Buffer.from([brand.length]), brand,
          Buffer.from([vers.length]), vers,
          Buffer.from([0x00, 0x00, 0x00]),
        ]));
      } else if (pktId === 0x04) {
        const nameLen = buf[1] || 0;
        const parsedName = buf.subarray(2, 2 + nameLen).toString('utf8').replace(/[^a-zA-Z0-9_]/g, '') || 'Player';
        const uuid = offlineUuid(parsedName);

        const nameBuf = Buffer.from(parsedName, 'utf8');
        const allowPkt = Buffer.concat([Buffer.from([0x05, nameBuf.length]), nameBuf, uuid]);
        ws.send(allowPkt);

        state = 'MC_LOGIN';
        connectToJavaServer(parsedName);
      }
    } else if (state === 'PLAY' && tcpSocket && !tcpSocket.destroyed) {
      const lenBuf = writeVarInt(buf.length);
      if (compressionThreshold >= 0) {
        if (buf.length >= compressionThreshold) {
          const compressed = zlib.deflateSync(buf);
          const inner = Buffer.concat([writeVarInt(buf.length), compressed]);
          tcpSocket.write(Buffer.concat([writeVarInt(inner.length), inner]));
        } else {
          const inner = Buffer.concat([writeVarInt(0), buf]);
          tcpSocket.write(Buffer.concat([writeVarInt(inner.length), inner]));
        }
      } else {
        tcpSocket.write(Buffer.concat([lenBuf, buf]));
      }
    }
  });

  ws.on('close', cleanup);
  ws.on('error', cleanup);
}
