'use strict';

// Optional online-mode addon for the Eaglercraft bridge.
//
// The Java server stays online-mode=true and runs authlib-injector pointed at
// http://<bridge>:<port>/api/yggdrasil. authlib-injector asks this service
// instead of Mojang's session server. This is custom auth, not Microsoft/Mojang
// auth, and it is loaded only when the bridge is started with --online.

const crypto = require('crypto');
const fs = require('fs');

// SHA-1 over server id + shared secret + server public key, printed the way
// Java's BigInteger.toString(16) prints a signed 160-bit value.
function serverHash(serverId, secret, publicKeyDer) {
  const digest = crypto.createHash('sha1')
    .update(serverId, 'utf8')
    .update(secret)
    .update(publicKeyDer)
    .digest();
  let num = BigInt('0x' + digest.toString('hex'));
  if (num >= (1n << 159n)) num -= (1n << 160n);
  return num.toString(16);
}

function createOnlineMode(options) {
  const storePath = options.storePath;
  const sendJson = options.sendJson;
  if (!storePath) throw new Error('storePath is required');
  if (typeof sendJson !== 'function') throw new Error('sendJson is required');

  // authlib-injector wants a PEM public key in the API metadata, even though
  // these profiles have no signed properties yet.
  const publicKeyPem = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    .publicKey.export({ type: 'spki', format: 'pem' }).toString();

  let accounts = {};
  try {
    if (fs.existsSync(storePath)) {
      const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.accounts) accounts = parsed.accounts;
    }
  } catch (err) {
    console.warn('Could not read ' + storePath + ': ' + err.message);
  }

  let saveWarned = false;
  function saveAccounts() {
    try {
      fs.writeFileSync(storePath, JSON.stringify({ accounts }, null, 2) + '\n');
    } catch (err) {
      if (!saveWarned) {
        saveWarned = true;
        console.warn('Could not save ' + storePath + ': ' + err.message);
      }
    }
  }

  function profileFor(name) {
    const key = String(name);
    const existing = Object.keys(accounts).find((k) => k.toLowerCase() === key.toLowerCase());
    if (!existing) {
      accounts[key] = {
        id: crypto.randomUUID().replace(/-/g, ''),
        name: key,
        createdAt: new Date().toISOString(),
      };
      saveAccounts();
    }
    return accounts[existing || key];
  }

  function profileById(id) {
    const wanted = String(id || '').toLowerCase().replace(/-/g, '');
    for (const account of Object.values(accounts)) {
      if (String(account.id).toLowerCase() === wanted) return account;
    }
    return null;
  }

  function profileJson(account) {
    return { id: account.id, name: account.name, properties: [] };
  }

  const pendingJoins = new Map();
  const authTokens = new Map();

  function rememberJoin(joinHash, profile) {
    pendingJoins.set(String(joinHash), {
      id: profile.id,
      name: profile.name,
      expires: Date.now() + 60000,
    });
  }

  function readJsonBody(req, callback) {
    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) return callback(new Error('Body too large'));
      try {
        callback(null, body ? JSON.parse(body) : {});
      } catch {
        callback(new Error('Bad JSON'));
      }
    });
  }

  function authError(res, status, message, error = 'ForbiddenOperationException') {
    sendJson(res, { error, errorMessage: message }, status);
  }

  function authNoContent(res) {
    res.writeHead(204);
    res.end();
  }

  function handleRequest(req, res) {
    if (!req.url || !req.url.startsWith('/api/yggdrasil')) return false;

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      authError(res, 400, 'Bad URL', 'IllegalArgumentException');
      return true;
    }

    let pathname = url.pathname.replace(/^\/api\/yggdrasil/, '');
    if (!pathname) pathname = '/';
    pathname = pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && pathname === '/') {
      sendJson(res, {
        meta: {
          serverName: 'Eaglercraft Bridge',
          implementationName: 'eaglercraft-bridgetcp',
          implementationVersion: '1.0',
          feature: { non_email_login: true, enable_profile_key: false },
        },
        skinDomains: [],
        signaturePublickey: publicKeyPem,
      });
      return true;
    }

    if (req.method === 'POST' && pathname === '/authserver/authenticate') {
      readJsonBody(req, (err, data) => {
        if (err) return authError(res, 400, err.message, 'IllegalArgumentException');
        const username = String(data.username || '').trim();
        if (!username) return authError(res, 400, 'Username is required');
        const profile = profileFor(username);
        const accessToken = crypto.randomBytes(32).toString('hex');
        const clientToken = String(data.clientToken || crypto.randomBytes(16).toString('hex'));
        authTokens.set(accessToken, { profile, clientToken });
        sendJson(res, {
          accessToken,
          clientToken,
          availableProfiles: [profileJson(profile)],
          selectedProfile: profileJson(profile),
          user: { id: profile.id, properties: [] },
        });
      });
      return true;
    }

    if (req.method === 'POST' && pathname === '/authserver/refresh') {
      readJsonBody(req, (err, data) => {
        if (err) return authError(res, 400, err.message, 'IllegalArgumentException');
        const token = authTokens.get(String(data.accessToken || ''));
        if (!token) return authError(res, 403, 'Invalid token');
        const accessToken = crypto.randomBytes(32).toString('hex');
        authTokens.set(accessToken, { profile: token.profile, clientToken: token.clientToken });
        authTokens.delete(String(data.accessToken));
        sendJson(res, {
          accessToken,
          clientToken: token.clientToken,
          selectedProfile: profileJson(token.profile),
        });
      });
      return true;
    }

    if (req.method === 'POST' && pathname === '/authserver/validate') {
      readJsonBody(req, (err, data) => {
        if (err) return authError(res, 400, err.message, 'IllegalArgumentException');
        if (authTokens.has(String(data.accessToken || ''))) return authNoContent(res);
        return authError(res, 403, 'Invalid token');
      });
      return true;
    }

    if (req.method === 'POST' && (pathname === '/authserver/invalidate' || pathname === '/authserver/signout')) {
      readJsonBody(req, (err, data) => {
        if (err) return authError(res, 400, err.message, 'IllegalArgumentException');
        if (pathname === '/authserver/invalidate') authTokens.delete(String(data.accessToken || ''));
        return authNoContent(res);
      });
      return true;
    }

    if (req.method === 'POST' && pathname === '/sessionserver/session/minecraft/join') {
      readJsonBody(req, (err, data) => {
        if (err) return authError(res, 400, err.message, 'IllegalArgumentException');
        const token = authTokens.get(String(data.accessToken || ''));
        if (!token) return authError(res, 403, 'Invalid token');
        const selected = String(data.selectedProfile || '').toLowerCase().replace(/-/g, '');
        if (selected && selected !== String(token.profile.id).toLowerCase()) {
          return authError(res, 403, 'Profile does not belong to this token');
        }
        if (typeof data.serverId !== 'string') return authError(res, 400, 'serverId is required');
        rememberJoin(data.serverId, token.profile);
        authNoContent(res);
      });
      return true;
    }

    if (req.method === 'GET' && pathname === '/sessionserver/session/minecraft/hasJoined') {
      const username = String(url.searchParams.get('username') || '');
      const joinHash = String(url.searchParams.get('serverId') || '');
      const join = pendingJoins.get(joinHash);
      if (!join || join.expires < Date.now() || join.name.toLowerCase() !== username.toLowerCase()) {
        if (join && join.expires < Date.now()) pendingJoins.delete(joinHash);
        authNoContent(res);
        return true;
      }
      sendJson(res, { id: join.id, name: join.name, properties: [] });
      return true;
    }

    if (req.method === 'GET' && pathname.startsWith('/sessionserver/session/minecraft/profile/')) {
      const id = pathname.slice('/sessionserver/session/minecraft/profile/'.length);
      const profile = profileById(id);
      if (!profile) {
        authNoContent(res);
        return true;
      }
      sendJson(res, profileJson(profile));
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/profiles/minecraft') {
      readJsonBody(req, (err, data) => {
        if (err) return authError(res, 400, err.message, 'IllegalArgumentException');
        if (!Array.isArray(data)) return authError(res, 400, 'Expected an array of names');
        const out = [];
        for (const name of data.slice(0, 100)) {
          const key = Object.keys(accounts).find((k) => k.toLowerCase() === String(name).toLowerCase());
          if (key) out.push(profileJson(accounts[key]));
        }
        sendJson(res, out);
      });
      return true;
    }

    authError(res, 404, 'Not found', 'NotFoundException');
    return true;
  }

  function startupLines(bindHost, wsPort) {
    const authHost = bindHost === '0.0.0.0' || bindHost === '::' ? '<this-host>' : bindHost;
    return [
      `  Auth server  : http://${authHost}:${wsPort}/api/yggdrasil`,
      `  Start Java   : java -javaagent:authlib-injector.jar=http://127.0.0.1:${wsPort}/api/yggdrasil -jar server.jar`,
      '  online-mode  : true (bridge auth, not Mojang/Microsoft auth)',
    ];
  }

  return {
    publicKeyPem,
    profileFor,
    profileById,
    rememberJoin,
    serverHash,
    handleRequest,
    startupLines,
    statusText: '<code>online-mode=true</code> with authlib-injector pointed at this bridge',
  };
}

module.exports = { createOnlineMode, serverHash };
