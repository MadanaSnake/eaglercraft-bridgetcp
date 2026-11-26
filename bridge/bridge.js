const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const zlib = require('zlib');
const crypto = require('crypto');
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
let PROTOCOL_VERSION = parseInt(process.env.MC_PROTOCOL || ARGS[3] || '777', 10); // 777 = 26.2/26.3

// The plain HTTP/WS listener always runs: 26.2/26.3 accept ws://, and browsers
// exempt localhost from mixed-content blocking. WSS=1 adds a second, TLS
// listener for clients that only accept wss:// (the 1.8.8/1.12.2 builds).
const USE_WSS = process.argv.includes('--wss') || /^(1|true|yes|on)$/i.test(String(process.env.WSS || ''));
const WSS_PORT = parseInt(process.env.WSS_PORT || String(WS_PORT + 1), 10);
const CERT_FILE = process.env.CERT_FILE || 'bridge-cert.pem';
const KEY_FILE = process.env.KEY_FILE || 'bridge-key.pem';

// Optional: serve an Eaglercraft build from this server at /play, so the game
// page and the WebSocket share one origin (no mixed content, one certificate).
const CLIENT_HTML = process.env.CLIENT_HTML || '';

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
  body { font-family: system-ui, sans-serif; background: #12141a; color: #e6edf3; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
  .card { background: #1b1f27; border: 1px solid #30363d; border-radius: 10px; padding: 24px; width: 100%; max-width: 420px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); }
  h1 { font-size: 1.2rem; margin: 0 0 16px; color: #58a6ff; }
  label { display: block; font-size: 0.85rem; color: #8b949e; margin: 12px 0 4px; }
  input { width: 100%; box-sizing: border-box; padding: 9px 10px; border-radius: 6px; border: 1px solid #30363d; background: #0d1117; color: #e6edf3; font-size: 0.95rem; }
  .hint { font-size: 0.75rem; color: #8b949e; margin-top: 4px; }
  button { margin-top: 16px; width: 100%; padding: 10px; border: 0; border-radius: 6px; background: #238636; color: #fff; font-weight: 600; font-size: 0.95rem; cursor: pointer; }
  button:hover { background: #2ea043; }
  .ws-box { margin-top: 16px; padding: 10px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; font-size: 0.85rem; display: flex; justify-content: space-between; align-items: center; }
  .ws-box code { color: #7ee787; }
  .copy-btn { width: auto; margin: 0; padding: 4px 10px; font-size: 0.75rem; background: #30363d; }
  .status { margin-top: 10px; font-size: 0.85rem; color: #7ee787; min-height: 1.2em; }
</style>
</head>
<body>
<div class="card">
  <h1>Eaglercraft &harr; Java TCP Bridge</h1>
  <label>Target Java Server IP / Domain</label>
  <input id="host" placeholder="e.g. play.pika-network.net">
  <label>Target Java Server Port</label>
  <input id="port" type="number" placeholder="25565">
  <label>Minecraft Protocol Version</label>
  <input id="proto" type="number" placeholder="777">
  <div class="hint">Hints: 26.2/26.3 = 777 | 1.21.4 = 769 | 1.20.1 = 763 | 1.8.8 = 47</div>
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
  <div class="ws-box" id="playBox" style="display:none;">
    <span>Game page: <a href="/play" style="color:#7ee787;">/play</a></span>
    <button class="copy-btn" onclick="window.open('/play', '_blank')">Open</button>
  </div>
</div>
<script>
  let wsUrl = 'ws://' + location.hostname + ':' + location.port;
  document.getElementById('wsUrl').textContent = wsUrl;
  function copyUrl(id) {
    const value = document.getElementById(id).textContent;
    navigator.clipboard.writeText(value);
    document.getElementById('status').textContent = 'Copied ' + value;
  }
  fetch('/api/config').then(r => r.json()).then(c => {
    document.getElementById('host').value = c.mcHost;
    document.getElementById('port').value = c.mcPort;
    document.getElementById('proto').value = c.protocolVersion;
    wsUrl = 'ws://' + location.hostname + ':' + c.wsPort;
    document.getElementById('wsUrl').textContent = wsUrl;
    if (c.wssEnabled) {
      document.getElementById('wssUrl').textContent = 'wss://' + location.hostname + ':' + c.wssPort;
      document.getElementById('wssBox').style.display = 'flex';
    }
    if (c.playUrl) document.getElementById('playBox').style.display = 'flex';
  });
  function save() {
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mcHost: document.getElementById('host').value.trim() || '127.0.0.1',
        mcPort: parseInt(document.getElementById('port').value, 10) || 25565,
        protocolVersion: parseInt(document.getElementById('proto').value, 10) || 777
      })
    }).then(r => r.json()).then(c => {
      document.getElementById('status').textContent = 'Updated: ' + c.mcHost + ':' + c.mcPort + ' (protocol ' + c.protocolVersion + ')';
    });
  }
  function testPing() {
    const st = document.getElementById('status');
    st.textContent = 'Pinging...';
    fetch('/api/ping').then(r => r.json()).then(p => {
      st.textContent = p.ok ? ('Ping to ' + p.host + ':' + p.port + ' = ' + p.pingMs + ' ms') : ('Ping failed: ' + p.error);
    }).catch(() => { st.textContent = 'Ping request failed'; });
  }
</script>
</body>
</html>`;

// --- HTTP + WebSocket Server ---
const requestHandler = (req, res) => {
  if (req.method === 'GET' && (req.url === '/play' || req.url === '/play.html') && CLIENT_HTML) {
    fs.stat(CLIENT_HTML, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('CLIENT_HTML not found: ' + CLIENT_HTML);
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
      });
      const stream = fs.createReadStream(CLIENT_HTML);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    });
  } else if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(UI_HTML);
  } else if (req.method === 'GET' && req.url === '/play' && !CLIENT_HTML) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No client configured. Start the bridge with CLIENT_HTML=/path/to/eaglercraft.html');
  } else if (req.method === 'GET' && req.url === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      mcHost: MC_HOST,
      mcPort: MC_PORT,
      protocolVersion: PROTOCOL_VERSION,
      wsPort: WS_PORT,
      wssEnabled: USE_WSS,
      wssPort: USE_WSS ? WSS_PORT : null,
      playUrl: CLIENT_HTML ? '/play' : null,
    }));
  } else if (req.method === 'POST' && req.url === '/api/config') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.mcHost) MC_HOST = String(data.mcHost).trim();
        if (data.mcPort) MC_PORT = parseInt(data.mcPort, 10) || 25565;
        if (data.protocolVersion) PROTOCOL_VERSION = parseInt(data.protocolVersion, 10) || 777;
        console.log(`[Config] Updated target -> ${MC_HOST}:${MC_PORT} (protocol ${PROTOCOL_VERSION})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ mcHost: MC_HOST, mcPort: MC_PORT, protocolVersion: PROTOCOL_VERSION }));
      } catch {
        res.writeHead(400);
        res.end('Bad JSON');
      }
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
if (CLIENT_HTML) {
  console.log(`  Game page    : /play (from CLIENT_HTML)`);
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
