# Cloudflare deployment

The app is served by Cloudflare Workers Assets. A Durable Object owns matchmaking, rooms, deck state, turns, and score calculation. The Worker only sends each player the cards they are allowed to see.

## Local development

Requires Node.js 20. Run from the repository root:

```sh
npm install
npm run dev
```

Open the local URL printed by Wrangler. The Worker serves the web app, `/api/health`, and the `/ws` WebSocket endpoint. Only browser assets are copied to `dist/`; Worker source and configuration are not published as static files.

## Deploy

1. Create or sign in to a Cloudflare account and install dependencies with `npm install`.
2. Authenticate Wrangler with `npx wrangler login`.
3. Deploy using `npm run deploy`.
4. Open the `workers.dev` URL. On the online screen, enter `https://<worker-host>` as the Worker URL; the client derives `wss://<worker-host>/ws` automatically.
5. Check `https://<worker-host>/api/health` for the health response.

## Deploy from GitHub

The workflow at `.github/workflows/deploy-cloudflare.yml` deploys on every push to `main` and can also be run manually from the repository's Actions tab.

1. Create a Cloudflare API token with Account `Workers Scripts: Edit` and `Account Settings: Read` permissions, scoped to the account that will own the Worker.
2. In the GitHub repository, open **Settings > Secrets and variables > Actions** and add repository secrets named `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
3. Commit and push the project to the repository's `main` branch. The Actions workflow installs Wrangler, builds `public/` into `dist/`, and deploys the Worker and Durable Object migration.
4. Check **Actions** for a successful `Deploy to Cloudflare` run. The deploy log contains the `workers.dev` URL; verify its `/api/health` endpoint before connecting the game.

Do not put the API token in the repository, workflow YAML, or chat. The workflow intentionally uses repository secrets.

Durable Object SQLite storage is provisioned by the `v1` migration in `wrangler.toml`. The first deployment creates the `GameHub` class. Do not rename the class or remove its migration after deployment without planning a Durable Object migration.

## WebSocket protocol

Messages are JSON. Send `session.join` first. The server responds with `session.ready` and a guest resume token.

- `match.quick`: joins the next available player for a 2-player quick match.
- `room.create`: creates a 6-character room ID with `maxPlayers` from 2 to 4.
- `room.join`: joins a waiting room; the game starts when the selected capacity is reached.
- `room.start`: the room host can start with at least 2 joined players before the room is full.
- `game.action`: `{ "action": "reveal" | "draw" | "discard", "index": 0 }` submits the current player's turn.
- `room.leave`: leaves a room.

The server sends `game.state` separately to each player. Hidden opponent cards are omitted from the payload. Guest resume tokens are bearer credentials; add authenticated accounts before using them as durable identities or storing sensitive profile data.

## Current scope

The Worker implements guest sessions, 2-player quick match, 2-4 player private rooms, reconnect grace period, CPU takeover after 30 seconds, server-owned decks and turn validation, and per-player card visibility. Account authentication, D1-backed profiles and rankings, payments, and ad integrations are not configured. The current prototype routes all matches through one Durable Object, so production-scale matchmaking should shard this hub and add abuse controls before a public launch.
