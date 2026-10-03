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

The workflow deploys on pushes to `main`. For the first deployment, complete these steps in order:

1. Cloudflareにログインし、[API Tokens](https://dash.cloudflare.com/profile/api-tokens)からカスタムトークンを作成します。権限はAccountの`Workers Scripts: Edit`と`Account Settings: Read`にし、対象アカウントを選択します。
2. トークン作成後に表示される値をコピーします。トークンは再表示できないため、安全な場所に控えてください。リポジトリやチャットには貼り付けないでください。
3. GitHubの[Actions Secrets設定](https://github.com/su-chanpo/suzu-game-fourcard/settings/secrets/actions)を開き、**New repository secret**を2件作成します。`CLOUDFLARE_API_TOKEN`には手順2のトークン、`CLOUDFLARE_ACCOUNT_ID`にはCloudflareダッシュボードで確認できるAccount IDを設定します。
4. [Actions](https://github.com/su-chanpo/suzu-game-fourcard/actions)を開き、`Deploy to Cloudflare`の実行結果を確認します。push直後の実行がSecrets登録前に失敗または停止していた場合は、Secrets登録後に **Deploy to Cloudflare > Run workflow > main > Run workflow** で再実行します。
5. 実行が成功したらログに表示される`workers.dev` URLを開き、`https://<Workerのホスト名>/api/health`が`"ok":true`を返すことを確認します。ゲームのオンライン画面には、`https://<Workerのホスト名>`を入力します。

GitHub ActionsはNode.js 20とWranglerを実行環境内に用意するため、デプロイだけなら手元のPCにNode.jsをインストールする必要はありません。

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
