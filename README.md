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
| `WSS` | unset | `1` serves HTTPS + `wss://` instead of HTTP + `ws://` |
| `CERT_FILE` | `bridge-cert.pem` | TLS certificate (generated on first `WSS=1` run) |
| `KEY_FILE` | `bridge-key.pem` | TLS private key |

## Older clients need wss://

26.2/26.3 accept a plain `ws://localhost:8081` address. The 1.8.8 and 1.12.2 builds only accept `wss://`, so the bridge can terminate TLS itself:

```bash
WSS=1 ./start-bridge.sh 8081          # Linux/macOS
set WSS=1 && start-bridge.bat 8081    # Windows
```

On the first run it writes `bridge-cert.pem` and `bridge-key.pem` next to `bridge.js` (self-signed, `CN=localhost`, valid for `localhost`, `127.0.0.1` and `::1`). No browser trusts that certificate, so open `https://localhost:8081` once and accept the warning, then set the server address to `wss://localhost:8081`. Passing `--wss` works too (`node bridge.js 8081 --wss`), and the web UI shows a `wss://` address when TLS is on.

A certificate you already trust removes the warning — for example with `mkcert`:

```bash
mkcert -install && mkcert localhost 127.0.0.1 ::1
CERT_FILE=localhost+2.pem KEY_FILE=localhost+2-key.pem WSS=1 ./start-bridge.sh 8081
```

Certificate files are gitignored; never commit the private key.

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
