const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = [
  ['A', 1], ['2', 2], ['3', 3], ['4', 4], ['5', 5], ['6', 6], ['7', 7],
  ['8', 8], ['9', 9], ['10', 10], ['J', 0], ['Q', 12], ['K', 0],
];
const ROOM_CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const MAX_MESSAGE_BYTES = 4096;
const RECONNECT_GRACE_MS = 30_000;
const COMPLETE_ROOM_CLEANUP_MS = 30_000;

function jsonResponse(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') return jsonResponse({ ok: true, service: 'fourcard', region: request.cf?.colo || 'local' });
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return jsonResponse({ error: 'WebSocket upgrade required' }, 426);
      const id = env.GAME_HUB.idFromName('global-game-hub-v1');
      return env.GAME_HUB.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

export class GameHub {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return jsonResponse({ error: 'WebSocket upgrade required' }, 426);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ playerId: null, roomId: null });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, rawMessage) {
    try {
      const raw = typeof rawMessage === 'string' ? rawMessage : new TextDecoder().decode(rawMessage);
      if (raw.length > MAX_MESSAGE_BYTES) return this.send(ws, { type: 'error', code: 'message_too_large', message: 'メッセージが大きすぎます。' });
      const message = JSON.parse(raw);
      if (!message || typeof message.type !== 'string') throw new Error('メッセージ形式が正しくありません。');
      const attachment = ws.deserializeAttachment() || {};
      if (message.type === 'session.join') return await this.joinSession(ws, message);
      if (!attachment.playerId) throw new Error('先にセッションへ接続してください。');
      if (message.type === 'match.quick') return await this.quickMatch(ws, attachment, message);
      if (message.type === 'match.cancel') return await this.cancelMatch(ws, attachment);
      if (message.type === 'room.create') return await this.createRoom(ws, attachment, message);
      if (message.type === 'room.join') return await this.joinRoom(ws, attachment, message);
      if (message.type === 'room.settings') return await this.updateRoomSettings(ws, attachment, message);
      if (message.type === 'room.start') return await this.startRoom(ws, attachment);
      if (message.type === 'game.action') return await this.gameAction(ws, attachment, message);
      if (message.type === 'room.leave') return await this.leaveRoom(ws, attachment);
      throw new Error('未対応の操作です。');
    } catch (error) {
      this.send(ws, { type: 'error', code: 'invalid_request', message: error instanceof Error ? error.message : '処理に失敗しました。' });
    }
  }

  async webSocketClose(ws) {
    await this.markDisconnected(ws);
  }

  async webSocketError(ws) {
    await this.markDisconnected(ws);
  }

  async alarm() {
    const rooms = await this.ctx.storage.get('rooms') || {};
    const now = Date.now();
    let nextAlarm = Infinity;
    for (const roomId of Object.keys(rooms)) {
      const room = rooms[roomId];
      if (room.status === 'complete') {
        if (!room.completedAt || now - room.completedAt >= COMPLETE_ROOM_CLEANUP_MS) delete rooms[roomId];
        else nextAlarm = Math.min(nextAlarm, room.completedAt + COMPLETE_ROOM_CLEANUP_MS);
        continue;
      }
      for (const player of room.players) {
        if (!player.connected && !player.isCPU && player.disconnectedAt) {
          const remaining = player.disconnectedAt + RECONNECT_GRACE_MS - now;
          if (remaining <= 0) {
            player.isCPU = true;
            player.name = `${player.name} (CPU)`;
            this.broadcastRoom(room, { type: 'connection.cpu', playerId: player.id, message: `${player.name}の接続が切れたためCPUに切り替えました。` });
          } else {
            nextAlarm = Math.min(nextAlarm, player.disconnectedAt + RECONNECT_GRACE_MS);
          }
        }
      }
      if (room.status === 'playing') {
        if (room.players[room.current]?.isCPU) {
          await this.runDisconnectedCpu(room);
        } else if (room.turnDeadline && room.turnDeadline <= now) {
          const player = room.players[room.current];
          this.playCpuTurn(room, player, room.settings?.cpuDifficulty || 'normal');
          this.broadcastRoom(room, { type: 'turn.timeout', playerName: player.name });
          if (room.status === 'playing' && room.players[room.current]?.isCPU) await this.runDisconnectedCpu(room);
          else this.broadcastState(room);
        }
        if (room.turnDeadline && !room.players[room.current]?.isCPU) nextAlarm = Math.min(nextAlarm, room.turnDeadline);
      }
    }
    await this.ctx.storage.put('rooms', rooms);
    if (nextAlarm < Infinity) await this.ctx.storage.setAlarm(nextAlarm);
  }

  async joinSession(ws, message) {
    const name = this.cleanName(message.name, 'Player');
    const sessions = await this.ctx.storage.get('sessions') || {};
    let playerId;
    let token;
    let session = typeof message.resumeToken === 'string' ? sessions[message.resumeToken] : null;
    if (session) {
      ({ playerId, token } = session);
    } else {
      playerId = crypto.randomUUID();
      token = this.randomToken();
      session = { playerId, token, name };
      sessions[token] = session;
      await this.ctx.storage.put('sessions', sessions);
    }
    for (const previousSocket of this.ctx.getWebSockets()) {
      if (previousSocket !== ws && previousSocket.deserializeAttachment()?.playerId === playerId) {
        previousSocket.serializeAttachment({ playerId: null, roomId: null });
        previousSocket.close(1000, 'Session resumed in another connection');
      }
    }
    const rooms = await this.ctx.storage.get('rooms') || {};
    const room = Object.values(rooms).find((entry) => entry.players.some((player) => player.id === playerId));
    ws.serializeAttachment({ playerId, roomId: room?.id || null });
    if (room) {
      const player = room.players.find((entry) => entry.id === playerId);
      player.connected = true;
      player.disconnectedAt = null;
      player.name = name || player.name;
      if (player.isCPU && player.name.endsWith(' (CPU)')) player.name = player.name.slice(0, -6);
      player.isCPU = false;
      await this.ctx.storage.put('rooms', rooms);
    }
    this.send(ws, { type: 'session.ready', playerId, resumeToken: token });
    if (room) {
      this.send(ws, { type: room.status === 'waiting' ? 'room.joined' : 'match.found', roomId: room.id, hostId: room.hostId, matchType: room.matchType, passphrase: room.passphrase || room.id, settings: room.settings, maxPlayers: room.maxPlayers, players: this.publicPlayers(room) });
      if (room.status === 'playing') this.sendStateTo(ws, room, playerId);
      else this.broadcastRoom(room, { type: 'room.updated', roomId: room.id, players: room.players.map(({ id, name: playerName }) => ({ id, name: playerName })) });
    } else if ((await this.ctx.storage.get('queue') || []).some((entry) => entry.playerId === playerId)) {
      this.send(ws, { type: 'match.queued' });
    }
  }

  async quickMatch(ws, attachment, message) {
    const rooms = await this.ctx.storage.get('rooms') || {};
    if (this.findPlayerRoom(rooms, attachment.playerId)) throw new Error('すでにルームまたは対戦に参加しています。');
    let queue = await this.ctx.storage.get('queue') || [];
    queue = queue.filter((entry) => entry.playerId !== attachment.playerId && this.socketFor(entry.playerId) && !this.findPlayerRoom(rooms, entry.playerId));
    await this.ctx.storage.put('queue', queue);
    const room = Object.values(rooms)
      .filter((entry) => entry.status === 'waiting' && (!entry.matchType || entry.matchType === 'random') && entry.players.length < entry.maxPlayers)
      .sort((left, right) => left.createdAt - right.createdAt)[0];
    if (room) return await this.addPlayerToRoom(ws, attachment, rooms, room, message.name);
    queue.push({ playerId: attachment.playerId, name: this.cleanName(message.name, 'Player'), queuedAt: Date.now() });
    await this.ctx.storage.put('queue', queue);
    this.send(ws, { type: 'match.queued', position: queue.length });
  }

  async cancelMatch(ws, attachment) {
    const queue = (await this.ctx.storage.get('queue') || []).filter((entry) => entry.playerId !== attachment.playerId);
    await this.ctx.storage.put('queue', queue);
    this.send(ws, { type: 'match.cancelled' });
  }

  async createRoom(ws, attachment, message) {
    const rooms = await this.ctx.storage.get('rooms') || {};
    if (this.findPlayerRoom(rooms, attachment.playerId)) throw new Error('すでにルームまたは対戦に参加しています。');
    const maxPlayers = Number(message.maxPlayers);
    if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 4) throw new Error('プレイヤー人数は2〜4人で指定してください。');
    let roomId = this.randomRoomCode(5);
    while (rooms[roomId]) roomId = this.randomRoomCode(5);
    const room = this.newRoom([{ id: attachment.playerId, name: this.cleanName(message.name, 'Player'), isCPU: false, connected: true, turns: 0 }], roomId);
    room.maxPlayers = maxPlayers;
    room.hostId = attachment.playerId;
    room.matchType = 'random';
    room.passphrase = room.id;
    room.settings = { turnTimeSeconds: 60, cpuDifficulty: 'normal' };
    let queue = (await this.ctx.storage.get('queue') || []).filter((entry) => entry.playerId !== attachment.playerId && this.socketFor(entry.playerId) && !this.findPlayerRoom(rooms, entry.playerId));
    while (queue.length && room.players.length < room.maxPlayers) {
      const waitingPlayer = queue.shift();
      room.players.push({ id: waitingPlayer.playerId, name: this.cleanName(waitingPlayer.name, 'Player'), isCPU: false, connected: true, turns: 0 });
    }
    rooms[room.id] = room;
    await this.ctx.storage.put('rooms', rooms);
    await this.ctx.storage.put('queue', queue);
    ws.serializeAttachment({ ...attachment, roomId: room.id });
    this.send(ws, { type: 'room.created', roomId: room.id, hostId: room.hostId, matchType: room.matchType, passphrase: room.passphrase, settings: room.settings, players: this.publicPlayers(room), maxPlayers: room.maxPlayers });
    for (const player of room.players.slice(1)) {
      const playerSocket = this.socketFor(player.id);
      if (!playerSocket) continue;
      playerSocket.serializeAttachment({ playerId: player.id, roomId: room.id });
      this.send(playerSocket, { type: 'room.joined', roomId: room.id, hostId: room.hostId, matchType: room.matchType, passphrase: room.passphrase, settings: room.settings, maxPlayers: room.maxPlayers, players: this.publicPlayers(room) });
    }
    if (room.players.length > 1) {
      this.broadcastRoom(room, { type: 'room.updated', roomId: room.id, players: this.publicPlayers(room) });
    }
  }

  async joinRoom(ws, attachment, message) {
    const passphrase = this.normalizePassphrase(message.passphrase);
    if (!/^[A-HJ-NP-Z2-9]{5}$/.test(passphrase)) throw new Error('合言葉は5文字で入力してください。');
    const rooms = await this.ctx.storage.get('rooms') || {};
    const room = rooms[passphrase];
    if (!room || room.status !== 'waiting') throw new Error('その合言葉のルームが見つかりません。');
    if (this.findPlayerRoom(rooms, attachment.playerId)) throw new Error('すでにルームまたは対戦に参加しています。');
    await this.addPlayerToRoom(ws, attachment, rooms, room, message.name);
  }

  async updateRoomSettings(ws, attachment, message) {
    const rooms = await this.ctx.storage.get('rooms') || {};
    const room = rooms[attachment.roomId];
    if (!room || room.status !== 'waiting' || room.hostId !== attachment.playerId) throw new Error('待機中のホストだけがルールを変更できます。');
    const turnTimeSeconds = Number(message.settings?.turnTimeSeconds);
    const cpuDifficulty = message.settings?.cpuDifficulty;
    if (![0, 30, 60, 90].includes(turnTimeSeconds)) throw new Error('制限時間の設定が正しくありません。');
    if (!['easy', 'normal', 'hard', 'expert'].includes(cpuDifficulty)) throw new Error('CPU難易度の設定が正しくありません。');
    room.settings = { turnTimeSeconds, cpuDifficulty };
    await this.ctx.storage.put('rooms', rooms);
    this.broadcastRoom(room, { type: 'room.updated', roomId: room.id, players: this.publicPlayers(room) });
  }

  async addPlayerToRoom(ws, attachment, rooms, room, name) {
    if (room.status !== 'waiting' || room.players.length >= room.maxPlayers) throw new Error('この募集は満員か、すでに始まっています。');
    room.players.push({ id: attachment.playerId, name: this.cleanName(name, 'Player'), isCPU: false, connected: true, turns: 0 });
    const queue = (await this.ctx.storage.get('queue') || []).filter((entry) => entry.playerId !== attachment.playerId);
    await this.ctx.storage.put('queue', queue);
    ws.serializeAttachment({ ...attachment, roomId: room.id });
    this.send(ws, { type: 'room.joined', roomId: room.id, hostId: room.hostId, matchType: room.matchType, passphrase: room.passphrase || room.id, settings: room.settings, maxPlayers: room.maxPlayers, players: this.publicPlayers(room) });
    this.broadcastRoom(room, { type: 'room.updated', roomId: room.id, players: this.publicPlayers(room) });
    await this.ctx.storage.put('rooms', rooms);
  }

  async startRoom(ws, attachment) {
    const rooms = await this.ctx.storage.get('rooms') || {};
    const room = rooms[attachment.roomId];
    if (!room || room.status !== 'waiting') throw new Error('開始できるルームがありません。');
    if (room.hostId !== attachment.playerId) throw new Error('ルーム作成者だけが対戦を開始できます。');
    if (room.players.length < 2) throw new Error('対戦には2人以上必要です。');
    while (room.players.length < room.maxPlayers) {
      const cpuNumber = room.players.filter((player) => player.isCPU).length + 1;
      room.players.push({ id: crypto.randomUUID(), name: `CPU ${cpuNumber}`, isCPU: true, connected: false, turns: 0 });
    }
    this.startGame(room);
    await this.ctx.storage.put('rooms', rooms);
    await this.scheduleAlarm(rooms);
    this.broadcastRoom(room, { type: 'room.started', roomId: room.id, players: this.publicPlayers(room) });
    this.broadcastState(room);
  }

  async gameAction(ws, attachment, message) {
    const rooms = await this.ctx.storage.get('rooms') || {};
    const room = rooms[attachment.roomId];
    if (!room || room.status !== 'playing') throw new Error('進行中の対戦がありません。');
    const player = room.players.find((entry) => entry.id === attachment.playerId);
    if (!player || player.isCPU || room.players[room.current].id !== player.id) throw new Error('現在の手番ではありません。');
    if (room.turnDeadline && room.turnDeadline <= Date.now()) {
      this.playCpuTurn(room, player, room.settings?.cpuDifficulty || 'normal');
      this.broadcastRoom(room, { type: 'turn.timeout', playerName: player.name });
      if (room.status === 'playing' && room.players[room.current]?.isCPU) await this.runDisconnectedCpu(room);
      await this.ctx.storage.put('rooms', rooms);
      await this.scheduleAlarm(rooms);
      this.broadcastState(room);
      return;
    }
    const index = Number(message.index);
    if (!Number.isInteger(index) || index < 0 || index > 3) throw new Error('カードの位置が正しくありません。');
    const slot = player.cards[index];
    if (message.action === 'reveal') {
      if (slot.revealed) throw new Error('このカードはすでに公開されています。');
      slot.revealed = true;
    } else if (message.action === 'draw') {
      const drawn = this.draw(room);
      room.waste.push(room.discard);
      room.discard = slot.card;
      slot.card = drawn;
      slot.revealed = false;
    } else if (message.action === 'discard') {
      const oldCard = slot.card;
      slot.card = room.discard;
      slot.revealed = true;
      room.discard = oldCard;
    } else {
      throw new Error('未対応のカード操作です。');
    }
    player.turns += 1;
    room.lastAction = { playerId: player.id, action: message.action, index };
    if (room.players.every((entry) => entry.turns >= 4)) {
      room.status = 'complete';
      room.turnDeadline = null;
      this.finishRoom(room);
    } else {
      room.current = (room.current + 1) % room.players.length;
      this.resetTurnDeadline(room);
    }
    const cpuTookTurns = room.status === 'playing' && room.players[room.current].isCPU;
    if (cpuTookTurns) await this.runDisconnectedCpu(room);
    await this.ctx.storage.put('rooms', rooms);
    await this.scheduleAlarm(rooms);
    if (!cpuTookTurns) this.broadcastState(room);
  }

  async leaveRoom(ws, attachment) {
    const rooms = await this.ctx.storage.get('rooms') || {};
    const room = rooms[attachment.roomId];
    if (!room) {
      const queue = (await this.ctx.storage.get('queue') || []).filter((entry) => entry.playerId !== attachment.playerId);
      await this.ctx.storage.put('queue', queue);
      ws.serializeAttachment({ ...attachment, roomId: null });
      this.send(ws, { type: 'match.cancelled' });
      return;
    }
    if (room) {
      const playerIndex = room.players.findIndex((entry) => entry.id === attachment.playerId);
      if (room.status === 'complete') {
        delete rooms[room.id];
      } else if (playerIndex >= 0 && room.status === 'waiting') {
        room.players.splice(playerIndex, 1);
        if (room.hostId === attachment.playerId) room.hostId = room.players[0]?.id || null;
        if (!room.players.length) delete rooms[room.id];
        else this.broadcastRoom(room, { type: 'room.updated', roomId: room.id, players: this.publicPlayers(room) });
      } else if (playerIndex >= 0 && room.status === 'playing') {
        const player = room.players[playerIndex];
        player.connected = false;
        player.disconnectedAt = Date.now();
        player.isCPU = true;
        player.name = `${player.name} (CPU)`;
        this.broadcastRoom(room, { type: 'connection.cpu', playerId: player.id, message: `${player.name}が退出したためCPUに切り替えました。` });
        if (room.players[room.current].id === player.id) await this.runDisconnectedCpu(room);
      }
      await this.ctx.storage.put('rooms', rooms);
      await this.scheduleAlarm(rooms);
    }
    ws.serializeAttachment({ ...attachment, roomId: null });
    this.send(ws, { type: 'room.left' });
  }

  async markDisconnected(ws) {
    const attachment = ws.deserializeAttachment() || {};
    if (!attachment.playerId) return;
    const rooms = await this.ctx.storage.get('rooms') || {};
    const room = rooms[attachment.roomId];
    if (room) {
      const player = room.players.find((entry) => entry.id === attachment.playerId);
      if (player && !player.isCPU) {
        if (this.ctx.getWebSockets().some((candidate) => candidate !== ws && candidate.deserializeAttachment()?.playerId === player.id && candidate.readyState === WebSocket.OPEN)) return;
        player.connected = false;
        player.disconnectedAt = Date.now();
        await this.ctx.storage.put('rooms', rooms);
        await this.scheduleAlarm(rooms);
        this.broadcastRoom(room, { type: 'connection.lost', playerId: player.id, reconnectInSeconds: RECONNECT_GRACE_MS / 1000 });
      }
    }
  }

  async runDisconnectedCpu(room) {
    let safety = 0;
    while (room.status === 'playing' && room.players[room.current].isCPU && safety < 16) {
      safety += 1;
      const player = room.players[room.current];
      this.playCpuTurn(room, player, room.settings?.cpuDifficulty || 'normal');
    }
    this.broadcastState(room);
  }

  playCpuTurn(room, player, difficulty) {
    const hidden = player.cards.map((slot, index) => !slot.revealed ? index : -1).filter((index) => index >= 0);
    const currentScore = this.score(player.cards);
    const publicScores = player.cards.map((_, slotIndex) => this.score(player.cards.map((slot, cardIndex) => ({ ...slot, card: cardIndex === slotIndex ? room.discard : slot.card }))));
    const bestPublicIndex = publicScores.indexOf(Math.min(...publicScores));
    let action = 'draw';
    let index = player.cards.reduce((bestIndex, slot, slotIndex, cards) => slot.card.point > cards[bestIndex].card.point ? slotIndex : bestIndex, 0);

    if (difficulty === 'easy') {
      const options = ['draw', 'discard', ...(hidden.length ? ['reveal'] : [])];
      action = options[Math.floor(Math.random() * options.length)];
      index = action === 'reveal' ? hidden[Math.floor(Math.random() * hidden.length)] : Math.floor(Math.random() * player.cards.length);
    } else if (difficulty === 'normal') {
      if (publicScores[bestPublicIndex] < currentScore) {
        action = 'discard';
        index = bestPublicIndex;
      } else if (hidden.length && Math.random() < 0.3) {
        action = 'reveal';
        index = hidden[Math.floor(Math.random() * hidden.length)];
      }
    } else {
      const candidates = room.deck.length ? room.deck : room.waste;
      const expectedScores = player.cards.map((_, slotIndex) => candidates.length
        ? candidates.reduce((total, card) => total + this.score(player.cards.map((slot, cardIndex) => ({ ...slot, card: cardIndex === slotIndex ? card : slot.card }))), 0) / candidates.length
        : currentScore);
      const bestDrawIndex = expectedScores.indexOf(Math.min(...expectedScores));
      if (publicScores[bestPublicIndex] <= expectedScores[bestDrawIndex]) {
        action = 'discard';
        index = bestPublicIndex;
      } else {
        action = 'draw';
        index = bestDrawIndex;
      }
      if (difficulty === 'expert' && hidden.length && Math.random() < 0.15) {
        action = 'reveal';
        index = hidden[Math.floor(Math.random() * hidden.length)];
      }
    }

    const slot = player.cards[index];
    if (action === 'reveal') {
      slot.revealed = true;
    } else if (action === 'discard') {
      const oldCard = slot.card;
      slot.card = room.discard;
      slot.revealed = true;
      room.discard = oldCard;
    } else {
      const drawn = this.draw(room);
      room.waste.push(room.discard);
      room.discard = slot.card;
      slot.card = drawn;
      slot.revealed = false;
    }
    player.turns += 1;
    room.lastAction = { playerId: player.id, action, index, automatic: true };
    if (room.players.every((entry) => entry.turns >= 4)) {
      room.status = 'complete';
      room.turnDeadline = null;
      this.finishRoom(room);
    } else {
      room.current = (room.current + 1) % room.players.length;
      this.resetTurnDeadline(room);
    }
  }

  newRoom(players, roomId = this.randomRoomCode(5)) {
    return { id: roomId, status: 'waiting', maxPlayers: 4, players, current: 0, deck: [], discard: null, waste: [], createdAt: Date.now() };
  }

  startGame(room) {
    room.deck = this.shuffle(SUITS.flatMap((suit) => RANKS.map(([rank, point]) => ({ suit, rank, point, color: suit === 'H' || suit === 'D' ? 'red-suit' : 'black-suit' }))));
    room.players.forEach((player) => {
      player.cards = Array.from({ length: 4 }, () => ({ card: room.deck.pop(), revealed: false }));
      player.turns = 0;
      player.score = null;
    });
    room.discard = room.deck.pop();
    room.waste = [];
    room.current = 0;
    room.status = 'playing';
    room.startedAt = Date.now();
    this.resetTurnDeadline(room);
  }

  resetTurnDeadline(room) {
    const seconds = room.settings?.turnTimeSeconds || 0;
    room.turnDeadline = room.status === 'playing' && seconds ? Date.now() + seconds * 1000 : null;
  }

  async scheduleAlarm(rooms) {
    let nextAlarm = Infinity;
    for (const room of Object.values(rooms)) {
      for (const player of room.players) {
        if (!player.connected && !player.isCPU && player.disconnectedAt) {
          nextAlarm = Math.min(nextAlarm, player.disconnectedAt + RECONNECT_GRACE_MS);
        }
      }
      if (room.status === 'playing' && room.turnDeadline && !room.players[room.current]?.isCPU) {
        nextAlarm = Math.min(nextAlarm, room.turnDeadline);
      }
      if (room.status === 'complete') {
        nextAlarm = Math.min(nextAlarm, (room.completedAt || Date.now()) + COMPLETE_ROOM_CLEANUP_MS);
      }
    }
    if (nextAlarm < Infinity) await this.ctx.storage.setAlarm(nextAlarm);
  }

  draw(room) {
    if (!room.deck.length && room.waste.length) room.deck = this.shuffle(room.waste.splice(0));
    return room.deck.pop();
  }

  score(cards) {
    const counts = new Map();
    for (const slot of cards) counts.set(slot.card.rank, (counts.get(slot.card.rank) || 0) + 1);
    const counted = new Set();
    return cards.reduce((total, slot) => {
      const count = counts.get(slot.card.rank);
      if (count % 2 === 1 && !counted.has(slot.card.rank)) {
        counted.add(slot.card.rank);
        return total + slot.card.point;
      }
      return total;
    }, 0);
  }

  finishRoom(room) {
    room.completedAt = Date.now();
    room.players.forEach((entry) => { entry.score = this.score(entry.cards); });
    room.players.sort((left, right) => left.score - right.score);
    let place = 0;
    let previousScore = null;
    room.players.forEach((entry, sortedIndex) => {
      if (entry.score !== previousScore) place = sortedIndex + 1;
      entry.place = place;
      previousScore = entry.score;
    });
  }

  viewFor(room, playerId) {
    const player = room.players.find((entry) => entry.id === playerId);
    return {
      roomId: room.id,
      status: room.status,
      players: room.players.map((entry) => ({
        id: entry.id,
        name: entry.name,
        isCPU: entry.isCPU,
        connected: entry.connected,
        turns: entry.turns,
        score: room.status === 'complete' ? entry.score : null,
        place: room.status === 'complete' ? entry.place : null,
        cards: entry.cards?.map((slot, index) => {
          const canSee = room.status === 'complete' || slot.revealed || (entry.id === playerId && index >= 2);
          return { card: canSee ? slot.card : null, revealed: slot.revealed, private: canSee && !slot.revealed };
        }) || [],
      })),
      currentPlayerId: room.status === 'complete' ? null : room.players[room.current]?.id,
      currentIndex: room.current,
      discard: room.discard,
      deckCount: room.deck.length,
      startedAt: room.startedAt,
      settings: room.settings || { turnTimeSeconds: 0, cpuDifficulty: 'normal' },
      turnDeadline: room.turnDeadline || null,
      you: playerId,
      lastAction: room.lastAction || null,
    };
  }

  sendStateTo(ws, room, playerId) {
    this.send(ws, { type: 'game.state', state: this.viewFor(room, playerId) });
  }

  broadcastState(room) {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() || {};
      if (attachment.roomId === room.id && attachment.playerId) this.sendStateTo(ws, room, attachment.playerId);
    }
  }

  broadcastRoom(room, message) {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() || {};
      if (attachment.roomId === room.id || room.players.some((player) => player.id === attachment.playerId)) {
        this.send(ws, { ...message, hostId: room.hostId, matchType: room.matchType, passphrase: room.passphrase || room.id, settings: room.settings, maxPlayers: room.maxPlayers });
      }
    }
  }

  publicPlayers(room) {
    return room.players.map(({ id, name, isCPU, connected }) => ({ id, name, isCPU, connected }));
  }

  findPlayerRoom(rooms, playerId) {
    return Object.values(rooms).find((room) => room.players.some((player) => player.id === playerId && room.status !== 'complete'));
  }

  socketFor(playerId) {
    return this.ctx.getWebSockets().find((ws) => ws.deserializeAttachment()?.playerId === playerId && ws.readyState === WebSocket.OPEN) || null;
  }

  send(ws, message) {
    try { ws.send(JSON.stringify(message)); } catch { /* The socket may close between lookup and send. */ }
  }

  cleanName(value, fallback) {
    return typeof value === 'string' ? value.trim().slice(0, 12) || fallback : fallback;
  }

  normalizePassphrase(value) {
    return typeof value === 'string' ? value.normalize('NFKC').trim().toUpperCase() : '';
  }

  randomToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  randomRoomCode(length = 5) {
    let code = '';
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    for (const byte of bytes) code += ROOM_CODE_CHARS[byte % ROOM_CODE_CHARS.length];
    return code;
  }

  shuffle(cards) {
    for (let index = cards.length - 1; index > 0; index -= 1) {
      const swapIndex = crypto.getRandomValues(new Uint32Array(1))[0] % (index + 1);
      [cards[index], cards[swapIndex]] = [cards[swapIndex], cards[index]];
    }
    return cards;
  }
}
