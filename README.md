# eaglercraft-bridgetcp

> **Info**: This was builded/coded entirely by AI *(yes im absolutely vibe-coded it :] )*

Play on a Java Minecraft server from an Eaglercraft client in your browser. One small Node.js file sits in the middle and translates between the two:

```text
Eaglercraft in your browser  --ws:// or wss://-->  bridge.js  --TCP-->  your Minecraft server
```

No `npm install`, no build step: the WebSocket layer (RFC 6455) is written into `bridge.js` itself.

## TL;DR - the 60-second version

1. **Install [Node.js](https://nodejs.org)** - take the LTS installer and click through it.
2. **Download [`Eaglercraft-bridge.zip`](../../releases/latest)** from Releases and unzip it wherever you like.
3. **Start the bridge** from that folder:
   - Windows: `start-bridge.bat 8081 --wss` in `cmd` for 1.8.8 / 1.12.2, or double-click `start-bridge.bat` for the plain `ws://` listener only
   - Linux / macOS: `WSS=1 ./start-bridge.sh` (if it says permission denied: `chmod +x start-bridge.sh`)
4. **Open <http://localhost:8081>**, enter your Java server's address and port, pick your Eaglercraft version in the dropdown, then click **Save & Apply**. **Test Ping** has to succeed.
5. **Connect the game** to the address the page shows for your version:
   - 26.2 / 26.3 clients -> `ws://127.0.0.1:8081`
   - 1.8.8 / 1.12.2 clients -> `wss://127.0.0.1:8082`, which needs the bridge started with `WSS=1` (see [Starting the bridge](#starting-the-bridge))

Two things cause almost every failure: the Java server's `online-mode` does not match how the bridge was started, or the version picked in the page is not the version of the client you are connecting with.

## What you need

- **[Node.js](https://nodejs.org) 14 or newer** - any current LTS is fine.
- **A Java Minecraft server you can join.** For a cracked/offline server, set `online-mode=false` in `server.properties` and restart it. For `online-mode=true`, use the [online-mode addon](#eaglercraft-friendly-online-modetrue-optional-addon) below: it keeps `online-mode=true` and gives the bridge its own small Yggdrasil auth service.
- **An Eaglercraft client**: the [fast-eaglercraft](https://github.com/MadanaSnake/fast-eaglercraft) 26.2 / 26.3 builds, or the official 1.12.2 / 1.8.8 downloads.

## Connect your client

| Client | Pick in the page | Connect the game to |
| --- | --- | --- |
| Eaglercraft 26.3 ([fast-eaglercraft](https://github.com/MadanaSnake/fast-eaglercraft)) | `Eaglercraft 26.3` (protocol `777`) | `ws://127.0.0.1:8081` |
| Eaglercraft 26.2 ([fast-eaglercraft](https://github.com/MadanaSnake/fast-eaglercraft)) | `Eaglercraft 26.2` (protocol `776`) | `ws://127.0.0.1:8081` |
| Eaglercraft 1.12.2 (official download) | `Eaglercraft 1.12.2` (protocol `340`) | `wss://127.0.0.1:8082` |
| Eaglercraft 1.8.8 (official download) | `Eaglercraft 1.8.8` (protocol `47`) | `wss://127.0.0.1:8082` |
| Anything else | **Custom protocol...**, e.g. `763` for 1.20.1 or `769` for 1.21.4 | whatever that client expects |

The number goes into the Java handshake and also selects the login packet layout (protocol 761+ sends a player UUID, 764+ sends Login Acknowledged), so it has to match the client exactly - otherwise the server kicks immediately as outdated.

The page keeps you honest: the 1.8.8 and 1.12.2 presets stay greyed out (`- needs WSS=1`) while the TLS listener is off, coloured chips at the top show which listeners are live (`ws:// <port>`, `wss:// <port>`, `/play`), and saving is refused if the host is empty or the port/protocol fall outside 1–65535. A protocol with no preset shows up as **Custom protocol...** with its number filled in.

### Starting the bridge

```bash
./start-bridge.sh              # plain listener on 8081
WSS=1 ./start-bridge.sh        # same, plus HTTPS + wss:// on 8082
./start-bridge.sh 9000         # move the bridge to 9000 (wss:// becomes 9001)
```

Windows, in `cmd`:

```bat
start-bridge.bat
set WSS=1 && start-bridge.bat
start-bridge.bat 8081 --wss
```

The last two are the same thing; the third avoids the environment variable and is the shortest way to get the 1.8.8 / 1.12.2 listener.

PowerShell:

```powershell
.\start-bridge.bat
$env:WSS=1; .\start-bridge.bat
```

The positional argument is always the bridge's own port; the target server is set in the web UI (or with the variables below).

### Eaglercraft-friendly `online-mode=true` (optional addon)

This is the optional `online-mode.js` extension. It keeps the Java server at `online-mode=true` while Eaglercraft players log in through the bridge. The bridge hosts a small Yggdrasil/session service, and authlib-injector tells the Java server to ask the bridge instead of Mojang. Keep `online-mode.js` in the same folder as `bridge.js`; the release zip already does.

**Requirements**

- A Java server you control. This cannot be used on a hosted public server where you cannot add a Java agent.
- [`authlib-injector.jar`](https://github.com/yushijinhun/authlib-injector/releases) - download the latest release and put it next to `server.jar`.
- The bridge and the Java server must be able to reach each other. On one machine, that is the default.

**Install**

1. In `server.properties`, keep online mode on. For 1.19+ also turn off secure profiles:

   ```properties
   online-mode=true
   enforce-secure-profile=false
   ```

2. Start the bridge with `--online` **before** starting the Java server:

   ```bash
   # Linux / macOS
   ./start-bridge.sh 8081 --online
   WSS=1 ./start-bridge.sh 8081 --online    # also for 1.8.8 / 1.12.2

   # Windows (cmd)
   start-bridge.bat 8081 --online
   set WSS=1 && start-bridge.bat 8081 --online
   ```

   The bridge must print both of these lines:

   ```text
   Auth server  : http://127.0.0.1:8081/api/yggdrasil
   online-mode  : true (bridge auth, not Mojang/Microsoft auth)
   ```

3. Start the Java server with authlib-injector pointed at the bridge:

   ```bash
   java -javaagent:authlib-injector.jar=http://127.0.0.1:8081/api/yggdrasil -jar server.jar nogui
   ```

   If the jar is not in the server folder, use its full path after `-javaagent:`. The URL must use the bridge plain HTTP port and end in `/api/yggdrasil`, even when the bridge also has `WSS=1` enabled.

4. Connect Eaglercraft normally:

   - 26.2 / 26.3: `ws://127.0.0.1:8081`
   - 1.8.8 / 1.12.2: `wss://127.0.0.1:8082` with `WSS=1`

   There is no extra login setting in the Eaglercraft client. The first time a username connects, the bridge creates a profile and UUID in `auth-accounts.json` next to `bridge.js`.

**Important notes**

- Start order matters: bridge first, then Java server. If the Java server starts first, authlib-injector logs `Failed to fetch metadata: Connection refused` and exits.
- Do not set `online-mode=false` when using this addon. `online-mode=true` is the point; authlib-injector replaces only the session lookup.
- If the Java server is on another machine, the bridge must listen on an address that machine can reach (`BIND_HOST=0.0.0.0`), and the javaagent URL must use that address instead of `127.0.0.1`. Firewall the bridge port.
- Deleting `auth-accounts.json` resets every UUID. Keep the file if you want stable player identities.
- This is **not Mojang or Microsoft authentication**. It cannot be used on a public server such as Hypixel, because you cannot install authlib-injector there. A real Microsoft-account login proxy would be a separate feature.

**Troubleshooting**

| Problem | Fix |
| --- | --- |
| `Failed to fetch metadata: Connection refused` | Start the bridge first, then the Java server. Check the port and that the URL ends in `/api/yggdrasil`. |
| `Invalid session` | The Java server must have `-javaagent:authlib-injector.jar=http://127.0.0.1:8081/api/yggdrasil` and `online-mode=true`; make sure the bridge was started with `--online`. |
| Kicked for chat/profile signatures | Add `enforce-secure-profile=false` to `server.properties` and restart. |
| Player UUID changed | `auth-accounts.json` was deleted or the bridge was started from a different folder. |

### Why 1.8.8 / 1.12.2 need `wss://`

The official 1.8.8 and 1.12.2 builds only connect over TLS, while Eaglercraft 26.2 / 26.3 happily use plain `ws://127.0.0.1:8081` because browsers treat `localhost` / `127.0.0.1` as trustworthy and do not block it as mixed content. That is the whole reason for the second listener: `WSS=1` serves both styles from one process.

### Making the certificate trusted

`wss://` fails during the handshake if the browser does not trust the certificate, and the game only shows a generic connection error. Two ways around it:

- **`mkcert`** - if it is installed, the bridge uses it automatically on the first run (`mkcert -install` once, then restart the bridge). No warning.
- **Click-through** - otherwise the bridge writes a self-signed `bridge-cert.pem` / `bridge-key.pem`. Open `https://127.0.0.1:8082` once and accept the warning; that exception covers `wss://` to the same host and port.

Certificate files are gitignored; never commit the private key.

### No local certificate: a tunnel

If you do not want to install anything on the machine running the bridge, put the plain listener behind a tunnel with a real certificate:

```bash
cloudflared tunnel --url http://localhost:8081
```

Use the `https://….trycloudflare.com` hostname it prints as `wss://<host>` in the client. The bridge stays on plain HTTP behind the tunnel; TLS ends at Cloudflare. The bridge ignores the WebSocket `Origin` header, so a page served from any origin connects the same way.

## Something not working?

| What you see | What to do |
| --- | --- |
| `Ping failed: Timed out (3000ms)` in the page | Wrong address/port, server offline, or a firewall/VPN in the way. Fix this first - nothing else works until ping succeeds. |
| Kicked for authentication / `online-mode` | Set `online-mode=false` and restart the Java server, **or** use the [online-mode addon](#eaglercraft-friendly-online-modetrue-optional-addon) and start the bridge with `--online`. Do not mix the two. |
| `--online` but still "Invalid session" | The Java server must start with `-javaagent:authlib-injector.jar=http://127.0.0.1:8081/api/yggdrasil`, the bridge must already be running, and the URL must end in `/api/yggdrasil`. |
| Kicked as outdated, or disconnected right after joining | The version in the dropdown is not the client's version. Use the matching preset, or **Custom protocol...**. |
| 1.8.8 / 1.12.2 do not connect at all | Start with `WSS=1` and use `wss://127.0.0.1:8082`. Accept the certificate warning once at `https://127.0.0.1:8082`. |
| 1.8.8 times out on the first try, works after | Known client-side quirk: press connect again. The bridge itself has no timeout on the game connection. |
| `Cannot listen on 127.0.0.1:8081` | Another program owns the port. `./start-bridge.sh 8082` (then `wss://` moves to 8083). |
| Double-clicking the Windows script flashes and closes | Run it from `cmd` so the error stays on screen. |

## Configuration

These can be set as environment variables when launching `bridge.js` directly. The web UI overrides the target values at runtime:

| Variable | Default | Description |
| --- | --- | --- |
| `WS_PORT` | `8081` | Port for the web UI and WebSocket |
| `MC_HOST` | `127.0.0.1` | Java server host |
| `MC_PORT` | `25565` | Java server port |
| `MC_PROTOCOL` | `777` | Initial protocol version (777 = 26.3, 776 = 26.2, 340 = 1.12.2, 47 = 1.8.8). The web UI overrides it |
| `BIND_HOST` | `127.0.0.1` | Interface to listen on. Use `0.0.0.0` for LAN access |
| `WSS` | unset | `1` adds a second, HTTPS + `wss://` listener next to the plain one |
| `AUTH_MODE` | unset | `online` is the same as `--online`: enable the embedded Yggdrasil/session service |
| `AUTH_STORE` | `auth-accounts.json` | Where the online-mode account/UUID store lives |
| `WSS_PORT` | `WS_PORT + 1` | Port for the HTTPS + `wss://` listener |
| `CERT_FILE` | `bridge-cert.pem` | TLS certificate (generated on the first `WSS=1` run) |
| `KEY_FILE` | `bridge-key.pem` | TLS private key |
| `CLIENT_HTML` | unset | Single-file Eaglercraft build to serve at `/play` |
| `CLIENT_DIR` | unset | Folder to serve at `/play` (its `index.html`) and under every path |

## Serve the game from the bridge

The bridge can host an Eaglercraft build too, so the game page, the config UI and the socket share one origin:

```bash
CLIENT_HTML=/path/to/eaglercraft.html WSS=1 ./start-bridge.sh 8081
```

`/play` serves that file on both listeners (streamed, so a 78 MB build is fine) and the config page gets an **Open** shortcut plus a `/play` chip. With `WSS=1`, `https://127.0.0.1:8082/play` puts the game page, the config UI and the socket on one certificate: accept the warning once, then connect the client to `wss://127.0.0.1:8082`. The plain listener also serves `http://127.0.0.1:8081/play`.

Split builds keep their payloads next to the page (`classes.wasm.br`, `assets.epk`, `sounds.epk`, ...), so a single HTML file can't be served on its own. Point the bridge at the folder instead:

```bash
CLIENT_DIR=/path/to/fast-eaglercraft ./start-bridge.sh 8081
```

`/play` becomes that folder's `index.html` (the launcher), every other path resolves inside the folder — so `/26.2/` serves the split build, `/26.2/classes.wasm.br` its payloads, and `/sounds.epk` the shared one, exactly as the folder is laid out on GitHub Pages. Paths that resolve outside the folder return 404.

You can also skip the environment variables: **Choose client...** on the config page opens a browser over this machine (folders and `.html` files only) and applies the pick immediately, so **Play** opens `/play` without a restart. Picking a folder serves everything inside it — launcher, split builds and single-file builds alike; picking one `.html` serves its folder and opens that file, so its siblings still resolve. Browsing is restricted to loopback clients, and the pick lives in memory — after a restart the bridge falls back to `CLIENT_DIR` / `CLIENT_HTML`.

## Security

The web UI can change the target server and check arbitrary host:port pairs. It listens on localhost only by default. If you set `BIND_HOST=0.0.0.0`, anyone on your network can use it, so add authentication or a firewall rule first.

## Download

Prebuilt packages are on the [Releases](../../releases) page as `Eaglercraft-bridge.zip`. The zip contains `bridge.js`, `online-mode.js`, both start scripts, this README and the license, so it unpacks straight into a runnable folder; the repository keeps the same files under `bridge/`.

## Repo layout

| Path | What it is |
| --- | --- |
| `bridge/bridge.js` | The bridge: config UI, WebSocket server, Java TCP client |
| `bridge/online-mode.js` | Optional `--online` addon: Yggdrasil/session service for authlib-injector |
| `bridge/start-bridge.sh`, `bridge/start-bridge.bat` | Launchers (check Node, then run `bridge.js`) |
| `README.md`, `LICENSE` | Docs |

## Known limitations

- **Not Mojang/Microsoft authentication.** The optional `--online` mode is custom auth: the bridge issues a profile per Eaglercraft username and answers the server's session check itself. Anyone who can reach the bridge can claim a username, so keep it on loopback or behind a firewall.
- Online mode needs a separate `authlib-injector.jar` and a Java server version that authlib-injector supports; the bridge does not bundle it.
- Protocol 764+ configuration-state handling (Login Acknowledged) is implemented and exercised by the 26.2/26.3 builds.
- The 1.8.8 client occasionally times out on its first handshake; reconnecting once goes through. The bridge has no timeout on the game connection itself - that timer lives in the client.

## License

MIT - see [LICENSE](LICENSE).
