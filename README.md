# eaglercraft-bridgetcp

> **Info**: This was builded/coded entirely by AI *(yes im absolutely vibe-coded it :] )*

A WebSocket-to-Java TCP bridge that lets an Eaglercraft client join a Java Minecraft server. Zero dependencies: the WebSocket layer (RFC 6455) is implemented inside `bridge.js`, so there is nothing to `npm install`.

## Requirements

- [Node.js](https://nodejs.org) 14 or newer
- A Java Minecraft server with `online-mode=false` in `server.properties`. The bridge does not support online-mode authentication.

## Quick start

1. Run `start-bridge.sh` (Linux/macOS) or `start-bridge.bat` (Windows). There is nothing to install.
2. Open `http://localhost:8081` and set the target Java server's host, port, and protocol version. Changes take effect immediately, no restart needed.
3. Connect your Eaglercraft client to `ws://localhost:8081`.

The start scripts only accept the bridge's own port, e.g. `./start-bridge.sh 8082`. The target server is set in the web UI or with the variables below.

## Configuration

These can be set as environment variables when launching `bridge.js` directly. The web UI overrides the target values at runtime:

| Variable | Default | Description |
| --- | --- | --- |
| `WS_PORT` | `8081` | Port for the web UI and WebSocket |
| `MC_HOST` | `127.0.0.1` | Java server host |
| `MC_PORT` | `25565` | Java server port |
| `MC_PROTOCOL` | `777` | Protocol version (777 = 26.2/26.3) |
| `BIND_HOST` | `127.0.0.1` | Interface to listen on. Use `0.0.0.0` for LAN access |
| `WSS` | unset | `1` adds a second, HTTPS + `wss://` listener next to the plain one |
| `WSS_PORT` | `WS_PORT + 1` | Port for the HTTPS + `wss://` listener |
| `CERT_FILE` | `bridge-cert.pem` | TLS certificate (generated on first `WSS=1` run) |
| `KEY_FILE` | `bridge-key.pem` | TLS private key |
| `CLIENT_HTML` | unset | Eaglercraft build to serve at `/play` |

## Which address does each client use?

Plain HTTP/WS always runs on `WS_PORT` (`ws://127.0.0.1:8081`). With `WSS=1` the same process *also* serves HTTPS + `wss://` on `WSS_PORT`, default `WS_PORT + 1` (`wss://127.0.0.1:8082`), so both connection styles are served by one process:

```bash
./start-bridge.sh 8081        # 26.2/26.3 over ws://
WSS=1 ./start-bridge.sh 8081  # same, plus wss:// on 8082
```

| Client | Address | Why |
| --- | --- | --- |
| This repo's 26.2/26.3 builds (served over https by GitHub Pages) | `ws://127.0.0.1:8081` | browsers treat `localhost`/`127.0.0.1` as trustworthy, so `ws://` is not blocked as mixed content |
| The same builds, or any other 26.2/26.3 | `wss://127.0.0.1:8082` | works once the certificate is trusted |
| eaglercraft.com 1.12.2 download | `wss://127.0.0.1:8082` | confirmed working — set the protocol to `340` in the config UI |
| eaglercraft.com 1.8.8 download | `wss://127.0.0.1:8082` | confirmed working — protocol `47`; retry once if the first handshake times out |
| Any client, any machine, no local certificate | `wss://<tunnel-host>` | see the tunnel section below |

The 26.2/26.3 builds from [fast-eaglercraft](https://github.com/MadanaSnake/fast-eaglercraft) and both official downloads (1.12.2 on protocol `340`, 1.8.8 on protocol `47`) are confirmed against this bridge. The config page lists both addresses with copy buttons, and the bridge ignores the WebSocket `Origin` header, so a page served from any origin connects the same way.

### Making the certificate trusted

`wss://` fails during the handshake if the browser does not trust the certificate, and the game only shows a generic connection error. Two ways around it:

- **`mkcert`** — if it is installed, the bridge uses it automatically on the first run (`mkcert -install` once, then restart the bridge). No warning.
- **Click-through** — otherwise the bridge writes a self-signed `bridge-cert.pem` / `bridge-key.pem`. Open `https://127.0.0.1:8082` once and accept the warning; that exception covers `wss://` to the same host and port.

Certificate files are gitignored; never commit the private key.

### No local certificate: a tunnel

If you do not want to install anything on the machine running the bridge, put the plain listener behind a tunnel that has a real certificate:

```bash
cloudflared tunnel --url http://localhost:8081
```

Use the `https://….trycloudflare.com` hostname it prints as `wss://<host>` in the client. The bridge stays on plain HTTP behind the tunnel; TLS ends at Cloudflare.

## Serve the game from the bridge

The bridge can host an Eaglercraft build too, so the game page, the config UI and the socket share one origin:

```bash
CLIENT_HTML=/path/to/eaglercraft.html WSS=1 ./start-bridge.sh 8081
```

`/play` serves that file on both listeners (streamed, so a 78 MB build is fine) and the config page gets an "Open" shortcut. With `WSS=1`, `https://127.0.0.1:8082/play` puts the game page, the config UI and the socket on one certificate: accept the warning once, then connect the client to `wss://127.0.0.1:8082`. The plain listener also serves `http://127.0.0.1:8081/play`.

## Security

The web UI can change the target server and check arbitrary host:port pairs. It listens on localhost only by default. If you set `BIND_HOST=0.0.0.0`, anyone on your network can use it, so add authentication or a firewall rule first.

## Download

Prebuilt packages are on the [Releases](../../releases) page as `Eaglercraft-bridge.zip`. The zip contains `bridge.js`, both start scripts, this README and the license, so it unpacks straight into a runnable folder; the repository keeps the same files under `bridge/`.

## Repo layout

| Path | What it is |
| --- | --- |
| `bridge/bridge.js` | The bridge: config UI, WebSocket server, Java TCP client |
| `bridge/start-bridge.sh`, `bridge/start-bridge.bat` | Launchers (check Node, then run `bridge.js`) |
| `README.md`, `LICENSE` | Docs |

## Known limitations

- Offline (cracked) mode only.
- Protocol 764+ configuration-state handling is implemented (Login Acknowledged) but has not been tested against a live server.
- Versions below 26.2 are not tested, such as 1.12.2 and 1.8.8. Those builds only accept `wss://`, so start the bridge with `WSS=1` (see above) if you want to try them.

## License

MIT — see [LICENSE](LICENSE).
