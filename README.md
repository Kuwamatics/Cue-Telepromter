# Cue teleprompter

A self-hosted teleprompter platform for presenters and teams.

- **Prompter:** smooth scrolling, a reading line with cue arrows, a countdown and progress, mirror and flip for beam-splitter glass. Highlights `[CUES]` and `*stressed words*`. Works with keyboard and presentation clickers, and goes full screen.
- **Reading pace:** set your speed in words per minute. The text moves so each word crosses the reading line at exactly that pace. Cues add a short beat, and `[PAUSE]` a longer one.
- **Second screen:** opens a window with only the scrolling text, for the monitor under your glass. In Chrome and Edge it moves itself to your external display. It has its own mirror and flip settings and stays in sync at exact pace, even at a different size. Keys pressed there control the main window.
- **Import:** Word (.docx), text and Markdown files. Bold words in Word come through highlighted.
- **Recording:** records video up to 4K at 24, 30 or 60 fps with 48 kHz voice, in the background while you read. Saves MP4 in current Chrome and Edge, otherwise WebM. Can write straight to disk for long takes.
- **Takes library:** takes upload to your server while you record, so you can play, download or share them from any device. Uploads resume after a dropped connection.
- **Accounts and sync:** scripts follow you across devices and update live.
- **Teams:** share scripts with your team. People join with an invite code.
- **Phone remote:** pair a phone with a 4-character code to play, pause, skip, change speed and start recording.
- **Voice follow:** the text scrolls as you speak (Chrome, Edge and Safari).
- **Script assistant:** tighten a script, make it conversational, add delivery cues, cut it to 60 seconds, or draft one from a brief. Needs an Anthropic API key.
- **Installable:** works as an app on phones and desktops (PWA).

One Node process, SQLite storage built into Node, and one dependency (`ws`).

## Run it on your computer

You need Node.js 22.9 or newer.

```bash
npm install
cp .env.example .env      # optional: add ANTHROPIC_API_KEY to turn on the assistant
npm start
```

Open http://localhost:8080 and create an account. The camera and microphone work on `localhost`. Anywhere else, the site needs HTTPS.

To try the phone remote from a phone on the same Wi-Fi, you need HTTPS. The quickest route is a tunnel such as `cloudflared tunnel --url http://localhost:8080`, which gives you a temporary https address.

## Deploy

The site must be served over **HTTPS**. Browsers only allow the camera, microphone and voice follow on secure sites.

**Render:** push this folder to a Git repo, then in Render choose New > Blueprint and select the repo. `render.yaml` sets up the service and a 1 GB disk for the database. Add `ANTHROPIC_API_KEY` when it asks.

**Docker** (any VPS, Fly.io, Railway and similar):

```bash
docker build -t cue .
docker run -d -p 8080:8080 -v cue-data:/data -e ANTHROPIC_API_KEY=sk-ant-... cue
```

Put it behind a reverse proxy that handles HTTPS (Caddy, nginx, Traefik or your platform's own). The proxy must pass WebSocket upgrades on `/ws`. With Caddy this is all you need:

```
cue.example.com {
  reverse_proxy localhost:8080
}
```

Keep `/data` on a persistent volume. That is where the database lives.

## Settings

| Variable | What it does | Default |
|---|---|---|
| `PORT` | Port to listen on | `8080` |
| `CUE_DATA` | Folder for the SQLite database | `./data` |
| `ANTHROPIC_API_KEY` | Turns on the script assistant | off |
| `CUE_AI_MODEL` | Model the assistant uses | `claude-sonnet-5-5` |
| `ANTHROPIC_BASE_URL` | Send assistant calls through a gateway | `https://api.anthropic.com` |
| `CUE_ALLOW_SIGNUP` | `0` stops new sign-ups | `1` |
| `CUE_SECURE` | `1` always marks the session cookie Secure | `0` |
| `CUE_TAKES_QUOTA_GB` | Takes storage per person, in GB | `20` |

## Back up

Scripts and accounts are in `data/cue.db` (plus its `-wal` file while the server runs). Recorded takes are files in `data/takes/`. To take a consistent copy of the database while the server runs:

```bash
sqlite3 data/cue.db ".backup cue-backup.db"
```

## How it is built

- `server.js`: the HTTP API, static files and a WebSocket for live sync and the remote. It also proxies the assistant, so your API key never reaches browsers.
- `public/index.html`: the teleprompter app.
- `public/platform.js`: the sign-in screen, the Account and team panel, and the adapters that connect the app to this server (storage, live rooms, speech recognition, assistant).
- `public/sw.js`, `manifest.webmanifest`: offline app shell and install support.

Recordings are saved on the presenter's device first. When the presenter is signed in, they also upload to `data/takes/` while recording. Turn off **Upload each take** to keep a take on the device only.

## Security notes

- Passwords are hashed with scrypt. Sessions are random tokens, stored hashed, in an HttpOnly SameSite cookie that lasts 30 days.
- Sign-in, sign-up, team joining and the assistant are rate-limited. Cross-site POSTs and WebSockets are refused.
- Personal scripts and unshared takes can only be read by their owner. Team scripts and shared takes can be read by members of that team. Only the person who recorded a take can share or delete it.
- Remote rooms only connect devices signed in to the same account.
- Pages are served with a strict Content-Security-Policy and a Permissions-Policy that allows the camera and microphone only for this site.
- Anyone with a team's invite code can join that team. Use **New code** to stop an old code working. Set `CUE_ALLOW_SIGNUP=0` once everyone has an account.

## Tests

```bash
npm test
```

This starts a throwaway server and checks sign-up and sign-in, live sync, privacy between users, team sharing, remote rooms, takes uploads (including retries, range requests and sharing), security headers and sign-out.

## Limits

- Up to 2,000 scripts per person and per team. Each script can be up to 256 KB of text.
- The device keeps a copy of each take in browser memory unless you choose **Save straight to a file while recording**. Turn that on for takes longer than about 20 minutes at 4K.
- Your reverse proxy must accept upload requests of up to 16 MB (nginx: `client_max_body_size 16m;`).
- Voice follow uses the browser's own speech recognition. In Chrome that service runs on Google's servers.

## Standalone file

`standalone.html` is a single-file version of the app with no server. Open it in Chrome or Edge to prompt and record on one computer. Scripts stay in that browser.
