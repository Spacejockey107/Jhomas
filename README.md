# Jhomas

A hands-free voice client for a self-hosted OpenCode agent. Speech recognition and speech synthesis run in the browser; only text goes to the server. The server side is one Caddy container in front of an existing OpenCode server.

Status: **Milestone 2** — hands-free voice: speech is transcribed in the browser, replies are spoken sentence by sentence. Barge-in, spoken status during tools, voice approvals and the wake word come next.

## Layout

```
caddy/Caddyfile        HTTPS, login, /api forwarding to OpenCode, static files
compose.snippet.yml    The service block for ~/docker/ai/compose.yml
site/                  The client, served at /
  agent/adapter.js       The generic agent contract
  agent/opencode-v1.js   The only OpenCode-specific code
  ui/                    Transcript, approval cards, debug panel
  voice.js               The voice loop: listen, transcribe, send, speak
  speech/                Speech engines (run in background threads), audio player, text helpers
  settings.js            Per-device voice settings
  config.js              Default models, voice settings and recognition corrections
tests/                 Milestone 0 test pages, served at /tests/
dev/                   Tools for testing without the real server (not served)
```

## Setup on spacejockey

These steps assume OpenCode already runs as the `opencode` service in `~/docker/ai/compose.yml`.

### 1. Get the code

```bash
cd ~/docker/ai
git clone https://github.com/Spacejockey107/Jhomas.git jhomas
```

`git clone` downloads the repository into `~/docker/ai/jhomas`. Later updates are `git pull` inside that folder.

### 2. Add three values to `~/docker/ai/.env`

**Your login name** for the Jhomas page (any name you like):

```bash
echo "JHOMAS_USER=yourname" >> ~/docker/ai/.env
```

**Your login password, stored as a hash.** Caddy only keeps a scrambled form (bcrypt hash) of the password, never the password itself:

```bash
docker run --rm -it caddy:2 caddy hash-password
```

- `docker run --rm -it caddy:2` starts a throwaway Caddy container (`--rm` deletes it afterwards; `-it` lets you type into it).
- `caddy hash-password` asks for the password twice and prints a hash starting with `$2a$`.

Open `.env` with `nano ~/docker/ai/.env` and add the hash **in single quotes** (the `$` signs would otherwise be treated as variables):

```
JHOMAS_PASSWORD_HASH='$2a$14$...the rest of the hash...'
```

**OpenCode's login in the form Caddy forwards.** This reads the existing OpenCode password from `.env` and appends it in encoded form:

```bash
PW=$(grep '^OPENCODE_SERVER_PASSWORD=' ~/docker/ai/.env | cut -d= -f2-)
echo "OPENCODE_AUTH_B64=$(printf 'opencode:%s' "$PW" | base64 -w0)" >> ~/docker/ai/.env
unset PW
```

- Line 1 copies the OpenCode password into a temporary shell variable.
- Line 2 encodes `opencode:<password>` in Base64 (the format HTTP logins use) and appends it to `.env`. `-w0` keeps it on one line.
- Line 3 clears the temporary variable.

### 3. Add the service

```bash
cp ~/docker/ai/compose.yml ~/docker/ai/compose.yml.bak-jhomas
nano ~/docker/ai/compose.yml
```

Paste the contents of `compose.snippet.yml` under `services:`, at the same indentation as the other services.

### 4. Start it

```bash
cd ~/docker/ai
docker compose up -d jhomas
docker compose logs --tail 30 jhomas
```

The log should show Caddy issuing a certificate for `10.10.0.1` and no errors.

### 5. Trust the certificate (once per device)

**Windows (Vivaldi, Chrome, Edge):**

1. Open `https://10.10.0.1:8443/root.crt`. The browser warns that the connection isn't private, because the certificate isn't trusted yet. Choose *Advanced* → *Proceed*, then log in. The file `root.crt` downloads.
2. Double-click `root.crt` → *Install Certificate* → *Current User* → *Place all certificates in the following store* → *Browse* → *Trusted Root Certification Authorities* → *Finish*, and confirm the security warning with *Yes*.
3. Restart the browser. `https://10.10.0.1:8443` should now open with no warning. You can delete the downloaded file.

**Android:** covered in Milestone 5.

### 6. Run the tests

Open `https://10.10.0.1:8443/tests/`.

## Using it

Open `https://10.10.0.1:8443`. It opens your most recent OpenCode conversation; *New* starts another, and the drop-down switches between them. Approvals appear above the message box and wait until you answer.

**Voice:** press *Voice off* to turn the mic on. The first time, the page downloads the speech models (several hundred MB; later visits load them from the browser's cache). While it shows *Listening*, everything you say is sent when you pause; the reply is spoken on the device that sent the message. Typed messages are spoken too while voice is on. *Voice settings* changes the voice, speed and models for this browser.

*Debug* shows each turn's timings (end of speech → sent → first text → first audio → finished) and the raw events.

## Testing without the server

`dev/mock-opencode.mjs` serves the client and replays an event recording from `tests/api.html`, pausing at approvals until the page answers:

```bash
node dev/mock-opencode.mjs opencode-events.json 8765
```

`dev/replay-opencode.mjs` prints what the adapter makes of a recording. `dev/test-text.mjs` checks sentence splitting, speech cleanup and recognition corrections.

## Updating

```bash
cd ~/docker/ai/jhomas && git pull
```

Caddy serves changed page files immediately. After a change to the Caddyfile, run `docker compose restart jhomas` from `~/docker/ai`.
