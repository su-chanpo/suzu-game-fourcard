# Cloudflareへのデプロイ

このアプリはCloudflare Workers Assetsで配信します。Durable Objectがマッチング、ルーム、山札、手番、得点計算を管理します。Workerは各プレイヤーが見てよいカードだけを送信します。

## ローカルでの開発

Node.js 20が必要です。リポジトリのルートフォルダーで次を実行します。

```sh
npm install
npm run dev
```

Wranglerが表示するローカルURLを開いてください。WorkerはWebアプリ、`/api/health`、WebSocket接続先の`/ws`を提供します。ブラウザー用ファイルだけが`dist/`へコピーされ、Workerのソースコードや設定ファイルは静的ファイルとして公開されません。

## 手動でのデプロイ

1. Cloudflareアカウントを作成するか、既存のアカウントにログインし、`npm install`で依存パッケージをインストールします。
2. `npx wrangler login`を実行してWranglerをCloudflareに認証します。
3. `npm run deploy`を実行してデプロイします。
4. 発行された`workers.dev`のURLを開きます。ゲームのオンライン画面にはWorkerのURLとして`https://<worker-host>`を入力してください。WebSocket接続先の`wss://<worker-host>/ws`は自動で設定されます。
5. `https://<worker-host>/api/health`を開き、正常応答が返ることを確認します。

## GitHubからの自動デプロイ

`.github/workflows/deploy-cloudflare.yml`のGitHub Actionsワークフローは、`main`ブランチへのpushごとにデプロイします。GitHubのActions画面から手動で実行することもできます。初回デプロイ時は、次の手順を順番に行ってください。

1. [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens)を開き、カスタムトークンを作成します。権限にはAccountの`Workers Scripts: Edit`と`Account Settings: Read`を指定し、利用するCloudflareアカウントを1つだけ選択します。
2. 作成後に一度だけ表示されるトークンをコピーし、安全な場所に控えます。トークンをリポジトリやチャットに貼り付けないでください。
3. GitHubの[Actions Secrets設定](https://github.com/su-chanpo/suzu-game-fourcard/settings/secrets/actions)を開き、**New repository secret**から`CLOUDFLARE_API_TOKEN`を1件登録し、手順2のトークンを設定します。Account IDはWorkflowがCloudflare APIから自動取得します。
4. [GitHub Actions](https://github.com/su-chanpo/suzu-game-fourcard/actions)を開き、`Deploy to Cloudflare`の実行結果を確認します。Secretsの登録前に開始した実行が失敗した場合は、**Deploy to Cloudflare > Run workflow > main > Run workflow**を選んで再実行してください。
5. 実行が成功したら、ログに表示される`workers.dev`のURLを開きます。`https://<Workerのホスト名>/api/health`が`"ok":true`を返すことを確認してください。ゲームのオンライン画面には`https://<Workerのホスト名>`を入力します。

GitHub Actionsの実行環境にはNode.js 20とWranglerが用意されるため、GitHub経由でデプロイするだけなら、手元のPCにNode.jsをインストールする必要はありません。

Durable ObjectのSQLiteストレージは、`wrangler.toml`に記載した`v1`マイグレーションで作成します。初回デプロイ時に`GameHub`クラスが作成されます。デプロイ後にクラス名を変更したりマイグレーション設定を削除したりする場合は、事前にDurable Objectの移行計画を立ててください。

## WebSocketプロトコル

メッセージはJSON形式です。最初に`session.join`を送信してください。サーバーは`session.ready`とゲスト用の再接続トークンを返します。

- `match.quick`: 次に参加するプレイヤーと2人対戦を開始します。
- `room.create`: `maxPlayers`に2〜4人を指定して、6文字のルームIDを作成します。
- `room.join`: 参加待ちのルームに入ります。指定人数に達するとゲームが始まります。
- `room.start`: 参加者が2人以上いれば、満員になる前でもルーム作成者がゲームを開始できます。
- `game.action`: `{ "action": "reveal" | "draw" | "discard", "index": 0 }`を送信して、現在の手番の操作を行います。
- `room.leave`: 参加中のルームから退出します。

サーバーはプレイヤーごとに個別の`game.state`を送信します。相手の伏せ札はデータに含めません。ゲスト用再接続トークンを持つ人は、そのプレイヤーとして接続できます。トークンを永続的な本人確認や機密プロフィール情報の保存に利用する前に、アカウント認証を追加してください。

## 現在の対応範囲

Workerはゲストセッション、2人クイックマッチ、2〜4人のプライベートルーム、再接続猶予、30秒後のCPU代行、サーバー側での山札管理と手番検証、プレイヤーごとのカード表示制御に対応しています。アカウント認証、D1を使ったプロフィール・ランキング、決済、広告連携は未設定です。現在の試作版ではすべての対戦を1つのDurable Objectで処理します。一般公開や大規模運用の前に、処理の分割と不正利用対策を追加してください。
