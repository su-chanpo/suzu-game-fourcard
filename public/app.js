const SUITS = [
  { symbol: '♠', color: 'black-suit' },
  { symbol: '♥', color: 'red-suit' },
  { symbol: '♦', color: 'red-suit' },
  { symbol: '♣', color: 'black-suit' },
];
const RANKS = [
  { label: 'A', point: 1 },
  ...Array.from({ length: 9 }, (_, index) => ({ label: String(index + 2), point: index + 2 })),
  { label: 'J', point: 0 }, { label: 'Q', point: 12 }, { label: 'K', point: 0 },
];
const STORAGE_KEY = 'fourcard-v2';
const CARD_SKINS = [
  { id: 'standard', name: 'Standard', price: 0, color: '#fffdf7' },
  { id: 'dark', name: 'Dark', price: 80, color: '#263b37' },
  { id: 'classic', name: 'Classic', price: 100, color: '#f5e4bd' },
  { id: 'neon', name: 'Neon', price: 120, color: '#102626' },
  { id: 'premium', name: 'Premium', price: 0, premium: true, color: '#caa857' },
];
const TABLE_SKINS = [
  { id: 'green', name: 'Green Table', price: 0, color: '#153c37' },
  { id: 'blue', name: 'Blue Table', price: 90, color: '#24465b' },
  { id: 'dark', name: 'Dark Table', price: 110, color: '#292e2d' },
  { id: 'casino', name: 'Casino', price: 130, color: '#542c31' },
];
const TUTORIAL_STEPS = [
  ['4枚のカードを整えよう', '4枚のカードの合計点を低くするゲームです。プレイヤー全員が4回ずつ行動し、最後に最も低い点数の人が勝ちます。'],
  ['カードの点数', 'Aは1点、2〜10は数字どおり、JとKは0点、Qは12点です。点数の高いカードを交換して、手札を小さくしましょう。'],
  ['ペアは0点', '同じランクのカード2枚はペアになり、2枚とも0点です。3枚なら2枚がペアになり、残り1枚分だけ点数が加算されます。'],
  ['カードを開く', '裏向きのカードを1枚選んで公開できます。情報を確認できますが、そのターンは交換できません。'],
  ['山札と交換', '手札を1枚選び、山札から引いたカードと交換します。引いたカードは交換が終わるまで見えません。'],
  ['公開カードと交換', '場の公開カードと手札を交換できます。交換後のカードは公開され、次の人が取れるようになります。'],
  ['ゲーム終了と得点', '各プレイヤーが4回行動すると全カードが公開されます。ペアを0点として計算し、同点は同じ順位になります。'],
];
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const setupScreen = $('#setup-screen');
const gameScreen = $('#game-screen');
const resultScreen = $('#result-screen');
const handoffScreen = $('#handoff-screen');
const setupForm = $('#setup-form');
const playerNameInput = $('#player-name');
const playerCountInput = $('#player-count');
const difficultyInput = $('#difficulty');
const handGrid = $('#hand-grid');
const actionButtons = $$('.action-button');

function freshData() {
  return {
    profile: { name: 'Player 1' },
    onlineSession: { playerId: '', resumeToken: '' },
    coins: 100,
    cardSkins: ['standard'],
    tableSkins: ['green'],
    activeCardSkin: 'standard',
    activeTableSkin: 'green',
    settings: { bgm: false, sfx: true, vibration: false, notifications: false, serverUrl: '' },
    tutorialComplete: false,
    lastDailyBonus: '',
    history: [],
  };
}

function getStoredValue(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function loadData() {
  try {
    const stored = JSON.parse(getStoredValue(STORAGE_KEY) || 'null');
    if (!stored || typeof stored !== 'object') return freshData();
    const defaults = freshData();
    return {
      ...defaults,
      ...stored,
      profile: { ...defaults.profile, ...stored.profile },
      onlineSession: { ...defaults.onlineSession, ...stored.onlineSession },
      settings: { ...defaults.settings, ...stored.settings },
      history: Array.isArray(stored.history) ? stored.history : [],
      cardSkins: Array.isArray(stored.cardSkins) ? stored.cardSkins : defaults.cardSkins,
      tableSkins: Array.isArray(stored.tableSkins) ? stored.tableSkins : defaults.tableSkins,
    };
  } catch {
    return freshData();
  }
}

let data = loadData();
if (!getStoredValue(STORAGE_KEY)) {
  const previousName = getStoredValue('fourcard-player-name');
  if (previousName) data.profile.name = normalizeName(previousName, 'Player 1');
}
let game = null;
let selectedAction = null;
let busy = false;
let toastTimer = null;
let cpuTimer = null;
let turnTimerInterval = null;
let setupMode = 'cpu';
let tutorialIndex = 0;
let tutorialReturnView = 'home';
let rankingPeriod = 'daily';
let socket = null;
let reconnectTimer = null;
let intentionalDisconnect = false;
let onlineStartedAt = 0;
let onlineRoomHost = false;
let pendingInvitePassphrase = new URLSearchParams(location.search).get('room')?.trim().toUpperCase() || '';
if (!/^[A-HJ-NP-Z2-9]{5}$/.test(pendingInvitePassphrase)) pendingInvitePassphrase = '';
const PAGE_PATHS = { home: '/', play: '/play', online: '/online', rankings: '/rankings', stats: '/stats', skins: '/skins', settings: '/settings' };
const initialPageView = Object.keys(PAGE_PATHS).find((view) => PAGE_PATHS[view] === location.pathname) || 'home';
let bgmContext = null;
let bgmNodes = [];

function saveData() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch {
    showToast('端末にデータを保存できませんでした');
    return false;
  }
}

function showView(view, updateUrl = true) {
  const path = PAGE_PATHS[view];
  if (updateUrl && path && location.pathname !== path) history.pushState(null, '', `${path}${location.search}`);
  const ids = ['home-screen', 'play-screen', 'setup-screen', 'online-screen', 'rankings-screen', 'stats-screen', 'skins-screen', 'settings-screen', 'tutorial-screen', 'game-screen', 'result-screen', 'handoff-screen'];
  ids.forEach((id) => $(`#${id}`).classList.toggle('hidden', id !== `${view}-screen`));
  document.body.classList.toggle('in-game', view === 'game' || view === 'handoff');
  if (view === 'home') renderHome();
  if (view === 'rankings') renderRankings();
  if (view === 'stats') renderStats();
  if (view === 'skins') renderSkins();
  if (view === 'settings') renderSettings();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function createDeck() {
  return SUITS.flatMap((suit) => RANKS.map((rank) => ({ suit: suit.symbol, color: suit.color, rank: rank.label, point: rank.point, id: `${suit.symbol}-${rank.label}` })));
}

function shuffle(cards) {
  for (let index = cards.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [cards[index], cards[swapIndex]] = [cards[swapIndex], cards[index]];
  }
  return cards;
}

function calculateScore(cards) {
  const counts = new Map();
  for (const { card } of cards) counts.set(card.rank, (counts.get(card.rank) || 0) + 1);
  const counted = new Set();
  return cards.reduce((total, { card }) => {
    const count = counts.get(card.rank);
    if (count % 2 === 1 && !counted.has(card.rank)) {
      counted.add(card.rank);
      return total + card.point;
    }
    return total;
  }, 0);
}

function beginSetup(mode) {
  setupMode = mode;
  $('#setup-mode-label').textContent = mode === 'local' ? 'ローカル対戦' : 'CPU対戦';
  $('#difficulty-field').classList.toggle('hidden', mode === 'local');
  $('#local-name-fields').classList.toggle('hidden', mode !== 'local');
  $('#setup-title').innerHTML = mode === 'local' ? 'ローカル<span>対戦</span>' : 'CPU<span>対戦</span>';
  renderLocalNameInputs();
  showView('setup');
}

function renderLocalNameInputs() {
  const container = $('#local-name-fields');
  if (setupMode !== 'local') return;
  const count = Number(playerCountInput.value);
  const existing = [...container.querySelectorAll('input')].map((input) => input.value);
  container.innerHTML = Array.from({ length: count - 1 }, (_, index) => {
    const position = index + 2;
    return `<label>プレイヤー ${position} の名前<input class="text-input local-player-name" maxlength="12" value="${escapeHtml(existing[index] || '')}" placeholder="Player ${position}" /></label>`;
  }).join('');
}

function startGame() {
  const playerCount = Number(playerCountInput.value);
  const playerName = normalizeName(playerNameInput.value, 'Player 1');
  data.profile.name = playerName;
  saveData();
  const localNames = $$('.local-player-name').map((input, index) => normalizeName(input.value, `Player ${index + 2}`));
  const players = Array.from({ length: playerCount }, (_, index) => ({
    id: index,
    name: index === 0 ? playerName : setupMode === 'local' ? localNames[index - 1] : `CPU ${index}`,
    isCPU: setupMode === 'cpu' && index !== 0,
    cards: [],
    turns: 0,
    score: null,
  }));
  const deck = shuffle(createDeck());
  for (const player of players) player.cards = Array.from({ length: 4 }, () => ({ card: deck.pop(), revealed: false }));
  const discard = deck.pop();
  game = {
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    mode: setupMode,
    players,
    deck,
    discard,
    waste: [],
    current: 0,
    difficulty: difficultyInput.value,
    complete: false,
    startedAt: Date.now(),
    seen: new Set([discard.id]),
  };
  selectedAction = null;
  busy = false;
  if (setupMode === 'local') showHandoff();
  else {
    showView('game');
    renderGame();
    scheduleCpuTurn();
  }
}

function cardMarkup(card, back = false) {
  if (back) return '<div class="playing-card card-back" aria-label="裏向きのカード"></div>';
  const rank = escapeHtml(card.rank);
  const suit = escapeHtml(card.suit);
  const color = card.color === 'red-suit' ? 'red-suit' : 'black-suit';
  return `<div class="playing-card ${color}" aria-label="${rank}${suit}"><span class="card-corner">${rank}<br>${suit}</span><span class="card-suit">${suit}</span><span class="card-corner card-corner-bottom">${rank}<br>${suit}</span></div>`;
}

function renderGame() {
  if (!game) return;
  const currentPlayer = game.players[game.current];
  $('#round-label').textContent = `ROUND ${String(currentPlayer.turns + 1).padStart(2, '0')} / 04`;
  renderTurnTimer();
  $('#game-title').textContent = currentPlayer.isCPU ? `${currentPlayer.name}のターン` : game.mode === 'local' ? `${currentPlayer.name}のターン` : game.mode === 'online' && game.current !== game.meIndex ? `${currentPlayer.name}のターン` : 'あなたのターン';
  $('#deck-count').textContent = String(game.deck.length).padStart(2, '0');
  $('#discard-pile').innerHTML = game.discard ? cardMarkup(game.discard) : '';
  $('#draw-pile').disabled = game.mode === 'online' && (game.current !== game.meIndex || busy || game.complete);
  renderTrack();
  renderOpponents();
  renderHand();
  updateActionControls();
}

function renderTrack() {
  $('#turn-track').innerHTML = game.players.map((player, index) => `<div class="track-item ${index === game.current ? 'is-current' : ''} ${player.turns >= 4 ? 'is-done' : ''}"><strong>${escapeHtml(player.name)}</strong><em>${Math.min(player.turns, 4)} / 4</em></div>`).join('');
}

function renderTurnTimer() {
  const timer = $('#turn-timer');
  if (game?.mode !== 'online' || !game.turnTimeSeconds || !game.turnDeadline || game.complete) {
    timer.classList.add('hidden');
    timer.classList.remove('is-urgent');
    if (turnTimerInterval) clearInterval(turnTimerInterval);
    turnTimerInterval = null;
    return;
  }
  const update = () => {
    if (!game || game.mode !== 'online' || !game.turnDeadline) return;
    const remaining = Math.max(0, Math.ceil((game.turnDeadline - Date.now()) / 1000));
    timer.textContent = `残り ${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
    timer.classList.toggle('is-urgent', remaining <= 10);
  };
  timer.classList.remove('hidden');
  update();
  if (!turnTimerInterval) turnTimerInterval = setInterval(update, 1000);
}

function renderOpponents() {
  const viewerIndex = game.mode === 'local' ? game.current : game.mode === 'online' ? game.meIndex : 0;
  const seats = {
    top: $('#seat-top'),
    left: $('#seat-left'),
    right: $('#seat-right'),
  };
  Object.values(seats).forEach((seat) => seat.replaceChildren());
  game.players.forEach((player, index) => {
    if (index === viewerIndex) return;
    const relativeIndex = (index - viewerIndex + game.players.length) % game.players.length;
    const seat = game.players.length === 2 ? 'top' : relativeIndex === 1 ? 'right' : relativeIndex === 2 ? 'top' : 'left';
    const current = game.mode === 'online' && index === game.current;
    const opponent = document.createElement('div');
    opponent.className = `opponent${current ? ' is-current' : ''}`;

    const playerHeader = document.createElement('div');
    playerHeader.className = 'opponent-player';
    const avatar = document.createElement('span');
    avatar.className = `opponent-avatar${player.isCPU ? ' is-cpu' : ''}`;
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = player.isCPU ? '♟' : player.name.trim().slice(0, 1) || '?';
    const info = document.createElement('div');
    info.className = 'opponent-info';
    const heading = document.createElement('div');
    heading.className = 'opponent-heading';
    const name = document.createElement('strong');
    name.textContent = player.name;
    heading.append(name);
    if (game.complete) {
      const score = document.createElement('span');
      score.className = 'opponent-score';
      score.textContent = `${player.score} pt`;
      heading.append(score);
    }
    info.append(heading);
    if (game.mode === 'online') {
      const presence = document.createElement('span');
      const status = player.isCPU ? 'CPU操作' : player.connected === false ? '再接続中' : 'オンライン';
      presence.className = `opponent-presence ${player.isCPU ? 'is-cpu' : player.connected === false ? 'is-disconnected' : 'is-online'}`;
      const indicator = document.createElement('i');
      indicator.setAttribute('aria-hidden', 'true');
      presence.append(indicator, document.createTextNode(`${status}${current ? ' · 手番' : ''}`));
      info.append(presence);
    }
    playerHeader.append(avatar, info);

    const cardRow = document.createElement('div');
    cardRow.className = 'opponent-card-row';
    cardRow.setAttribute('aria-label', `${player.name}の手札`);
    player.cards.forEach(({ card, revealed }, cardIndex) => {
      const slot = document.createElement('div');
      slot.className = 'opponent-card-slot';
      const number = document.createElement('span');
      number.className = 'opponent-slot-number';
      number.textContent = `0${cardIndex + 1}`;
      const cardElement = document.createElement('div');
      cardElement.classList.add('playing-card');
      const isBack = !card || (!revealed && !game.complete);
      if (isBack) {
        cardElement.classList.add('card-back');
        cardElement.setAttribute('aria-label', '裏向きのカード');
      } else {
        cardElement.classList.add(card.color === 'red-suit' ? 'red-suit' : 'black-suit');
        cardElement.setAttribute('aria-label', `${card.rank}${card.suit}`);
        const addCorner = (bottom = false) => {
          const corner = document.createElement('span');
          corner.className = `card-corner${bottom ? ' card-corner-bottom' : ''}`;
          corner.append(document.createTextNode(String(card.rank)), document.createElement('br'), document.createTextNode(String(card.suit)));
          return corner;
        };
        const suit = document.createElement('span');
        suit.className = 'card-suit';
        suit.textContent = card.suit;
        cardElement.append(addCorner(), suit, addCorner(true));
      }
      const state = document.createElement('span');
      state.className = 'opponent-slot-state';
      state.textContent = revealed || game.complete ? 'OPEN' : 'HIDDEN';
      slot.append(number, cardElement, state);
      cardRow.append(slot);
    });
    opponent.append(playerHeader, cardRow);
    seats[seat].append(opponent);
  });
}

function renderHand() {
  const handPlayerIndex = game.mode === 'local' ? game.current : game.mode === 'online' ? game.meIndex : 0;
  const player = game.players[handPlayerIndex];
  const isHumanTurn = game.current === handPlayerIndex && !player.isCPU && !busy && !game.complete;
  const hasAllCards = player.cards.every((slot) => slot.card);
  const score = hasAllCards ? calculateScore(player.cards) : null;
  $('#hand-title').innerHTML = `${escapeHtml(player.name)} のカード <span id="hand-score">${score === null ? '???' : `${score} PT`}</span>`;
  handGrid.innerHTML = player.cards.map((slot, index) => {
    const ownerPrivate = Boolean(slot.private) || (index >= 2 && game.mode !== 'local' && !slot.revealed && game.mode !== 'online');
    const visible = Boolean(slot.card) && (slot.revealed || ownerPrivate || game.complete);
    const selectable = isHumanTurn && selectedAction && (selectedAction !== 'reveal' || !slot.revealed);
    const selected = Boolean(selectable && selectedAction === 'reveal' && !slot.revealed);
    const card = visible ? cardMarkup(slot.card) : cardMarkup(null, true);
    const state = slot.revealed ? 'OPEN' : ownerPrivate ? 'PRIVATE' : 'HIDDEN';
    return `<button class="hand-slot ${selectable ? 'is-selectable' : ''} ${selected ? 'is-selected' : ''} ${ownerPrivate && !slot.revealed ? 'is-private' : ''}" type="button" data-slot="${index}" ${selectable ? '' : 'disabled'} aria-label="${index + 1}番のカード、${visible ? `${slot.card.rank}${slot.card.suit}${ownerPrivate && !slot.revealed ? '、自分だけに表示' : ''}` : '裏向き'}"><span class="slot-number">0${index + 1}</span>${card}<span class="slot-state">${state}</span></button>`;
  }).join('');
  handGrid.querySelectorAll('.hand-slot').forEach((button) => button.addEventListener('click', () => performAction(Number(button.dataset.slot))));
}

function updateActionControls() {
  if (!game) return;
  const player = game.players[game.current];
  const humanTurn = !player.isCPU && !busy && !game.complete && (game.mode !== 'online' || game.current === game.meIndex);
  const hasHidden = player.cards.some((slot) => !slot.revealed);
  actionButtons.forEach((button) => {
    const action = button.dataset.action;
    button.classList.toggle('is-selected', selectedAction === action);
    button.disabled = !humanTurn || (action === 'reveal' && !hasHidden);
  });
  $('#action-prompt').textContent = busy ? (game.mode === 'online' ? 'サーバーに送信中…' : 'CPUが考えています…') : selectedAction ? actionPrompt(selectedAction) : '今回の行動を選んでください';
  $('#hand-hint').textContent = selectedAction ? 'カードをタップして確定' : '行動を選んでからカードをタップ';
}

function actionPrompt(action) {
  if (action === 'reveal') return '開きたい裏向きカードをタップ';
  if (action === 'draw') return '山札と交換するカードをタップ';
  return '公開カードと交換するカードをタップ';
}

function drawFromDeck() {
  if (!game.deck.length && game.waste.length) {
    game.deck = shuffle(game.waste.splice(0));
    showToast('捨て札を混ぜて山札を作り直しました');
  }
  return game.deck.pop() || null;
}

function replaceDiscard(card) {
  if (game.discard) game.waste.push(game.discard);
  game.discard = card;
  game.seen.add(card.id);
}

function performAction(slotIndex) {
  const player = game?.players[game.current];
  if (!player || busy || player.isCPU || game.complete || !selectedAction) return;
  const slot = player.cards[slotIndex];
  if (selectedAction === 'reveal' && slot.revealed) return;
  if (game.mode === 'online') {
    const action = selectedAction;
    busy = true;
    selectedAction = null;
    updateActionControls();
    if (!sendOnlineMessage({ type: 'game.action', action, index: slotIndex })) {
      busy = false;
      selectedAction = action;
      renderHand();
      updateActionControls();
    }
    return;
  }
  if (selectedAction === 'reveal') {
    slot.revealed = true;
    game.seen.add(slot.card.id);
    showToast(`${slot.card.rank}${slot.card.suit} を公開しました`);
  } else if (selectedAction === 'draw') {
    const drawn = drawFromDeck();
    if (!drawn) return showToast('山札がありません');
    replaceDiscard(slot.card);
    slot.card = drawn;
    slot.revealed = false;
    showToast('山札からカードを交換しました');
  } else {
    const oldCard = slot.card;
    slot.card = game.discard;
    slot.revealed = true;
    game.seen.add(slot.card.id);
    replaceDiscard(oldCard);
    showToast('公開カードと交換しました');
  }
  playEffect('card');
  selectedAction = null;
  finishTurn();
}

function expectedScoreAfterReplacement(player, index, replacement) {
  return calculateScore(player.cards.map((slot, slotIndex) => ({ card: slotIndex === index ? replacement : slot.card })));
}

function chooseCpuMove(player) {
  const hiddenIndices = player.cards.map((slot, index) => !slot.revealed ? index : -1).filter((index) => index >= 0);
  if (game.difficulty === 'easy') {
    const options = ['draw', 'discard', ...(hiddenIndices.length ? ['reveal'] : [])];
    const action = options[Math.floor(Math.random() * options.length)];
    return { action, index: action === 'reveal' ? hiddenIndices[Math.floor(Math.random() * hiddenIndices.length)] : Math.floor(Math.random() * 4) };
  }
  const currentScore = calculateScore(player.cards);
  const targets = player.cards.map((slot, index) => ({ index, publicScore: expectedScoreAfterReplacement(player, index, game.discard) }));
  const bestPublic = targets.reduce((best, target) => target.publicScore < best.publicScore ? target : best, targets[0]);
  const excluded = new Set([...game.seen, ...player.cards.map((slot) => slot.card.id)]);
  const unknownCards = createDeck().filter((card) => !excluded.has(card.id));
  const drawTargets = targets.map(({ index }) => {
    const expected = unknownCards.length ? unknownCards.reduce((sum, card) => sum + expectedScoreAfterReplacement(player, index, card), 0) / unknownCards.length : currentScore;
    return { index, expected };
  });
  const bestDraw = drawTargets.reduce((best, target) => target.expected < best.expected ? target : best, drawTargets[0]);
  if (bestPublic.publicScore < currentScore && bestPublic.publicScore <= bestDraw.expected) return { action: 'discard', index: bestPublic.index };
  if (game.difficulty === 'normal' && hiddenIndices.length && Math.random() < 0.3) return { action: 'reveal', index: hiddenIndices[Math.floor(Math.random() * hiddenIndices.length)] };
  if (game.difficulty === 'expert' && hiddenIndices.length && Math.random() < 0.2) return { action: 'reveal', index: hiddenIndices[Math.floor(Math.random() * hiddenIndices.length)] };
  if (game.difficulty === 'expert' && hiddenIndices.length && bestDraw.expected >= currentScore && Math.random() < 0.2) return { action: 'reveal', index: hiddenIndices[Math.floor(Math.random() * hiddenIndices.length)] };
  return { action: 'draw', index: bestDraw.index };
}

function playCpuTurn() {
  if (!game || game.complete || !game.players[game.current].isCPU) return;
  const player = game.players[game.current];
  const move = chooseCpuMove(player);
  const slot = player.cards[move.index];
  if (move.action === 'reveal') {
    slot.revealed = true;
    game.seen.add(slot.card.id);
    showToast(`${player.name}がカードを開きました`);
  } else if (move.action === 'discard') {
    const oldCard = slot.card;
    slot.card = game.discard;
    slot.revealed = true;
    replaceDiscard(oldCard);
    showToast(`${player.name}が公開カードを交換しました`);
  } else {
    const drawn = drawFromDeck();
    if (drawn) {
      replaceDiscard(slot.card);
      slot.card = drawn;
      slot.revealed = false;
    }
    showToast(`${player.name}が山札を交換しました`);
  }
  finishTurn();
}

function finishTurn() {
  game.players[game.current].turns += 1;
  if (game.players.every((player) => player.turns >= 4)) return endGame();
  game.current = (game.current + 1) % game.players.length;
  selectedAction = null;
  if (game.mode === 'local' && !game.players[game.current].isCPU) return showHandoff();
  showView('game');
  renderGame();
  scheduleCpuTurn();
}

function showHandoff() {
  clearTimeout(cpuTimer);
  const player = game.players[game.current];
  $('#handoff-title').textContent = `${player.name}の番です`;
  $('#handoff-message').textContent = 'ほかのプレイヤーに画面を見られないよう端末を渡し、準備ができたら進んでください。';
  showView('handoff');
}

function scheduleCpuTurn() {
  if (!game || game.complete || !game.players[game.current].isCPU) return;
  busy = true;
  renderGame();
  cpuTimer = window.setTimeout(() => {
    busy = false;
    playCpuTurn();
  }, 650);
}

function endGame() {
  game.complete = true;
  game.players.forEach((player) => {
    player.cards.forEach((slot) => { slot.revealed = true; });
    player.score = calculateScore(player.cards);
  });
  const ranked = [...game.players].sort((left, right) => left.score - right.score);
  const playedSeconds = Math.max(1, Math.round((Date.now() - game.startedAt) / 1000));
  const personalRank = ranked.findIndex((player) => player.id === 0);
  let place = 0;
  let previousScore = null;
  const record = {
    id: game.id,
    date: new Date().toISOString(),
    mode: game.mode,
    duration: playedSeconds,
    players: ranked.map((player, index) => {
      if (player.score !== previousScore) place = index + 1;
      previousScore = player.score;
      return { name: player.name, score: player.score, place, isSelf: player.id === 0 };
    }),
  };
  data.history.unshift(record);
  data.history = data.history.slice(0, 500);
  const reward = 5 + (personalRank === 0 ? 15 : 0);
  data.coins += reward;
  saveData();
  renderResults(ranked, reward, personalRank);
  showView('result');
  if (personalRank === 0) playEffect('win');
}

function renderResults(ranked, reward, personalRank) {
  const winner = ranked[0];
  const tied = ranked.filter((player) => player.score === winner.score).length > 1;
  $('#result-message').textContent = personalRank === 0 ? (tied ? '最少得点で首位に並びました。' : 'あなたがテーブルを制しました。') : `${winner.name} が1位です。次は手札を整えてリベンジ。`;
  $('#winner-panel').innerHTML = `<span class="winner-kicker">${tied ? 'LOW SCORE / TIED' : personalRank === 0 ? 'LOW SCORE / WINNER' : 'LOW SCORE / RESULT'}</span><strong class="winner-name">${escapeHtml(winner.name)}</strong><span class="winner-score">${winner.score} POINTS</span><div class="winner-cards">${winner.cards.map(({ card }) => cardMarkup(card)).join('')}</div><span class="reward-note">+${reward} COIN</span>`;
  let place = 0;
  let previousScore = null;
  $('#result-list').innerHTML = ranked.map((player, index) => {
    if (player.score !== previousScore) place = index + 1;
    previousScore = player.score;
    return `<div class="result-row ${(player.isSelf || player.id === 0) ? 'is-winner' : ''}"><span class="result-rank">${player.place || place}位</span><span class="result-name">${escapeHtml(player.name)}</span><span class="result-score">${player.score} pt</span></div>`;
  }).join('');
}

function getStats() {
  const stats = { games: 0, wins: 0, losses: 0, placements: [0, 0, 0, 0], highestScore: null, lowestScore: null, playSeconds: 0 };
  for (const match of data.history) {
    const self = match.players?.find((player) => player.isSelf);
    if (!self) continue;
    stats.games += 1;
    stats.placements[Math.min(self.place, 4) - 1] += 1;
    if (self.place === 1) stats.wins += 1;
    else stats.losses += 1;
    stats.highestScore = stats.highestScore === null ? self.score : Math.max(stats.highestScore, self.score);
    stats.lowestScore = stats.lowestScore === null ? self.score : Math.min(stats.lowestScore, self.score);
    stats.playSeconds += match.duration || 0;
  }
  return stats;
}

function getRankingEntries(period) {
  const now = new Date();
  const matches = data.history.filter((match) => {
    const date = new Date(match.date);
    if (period === 'daily') return date.toDateString() === now.toDateString();
    if (period === 'weekly') return (now - date) / 86_400_000 < 7;
    if (period === 'monthly') return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
    return true;
  });
  const entries = new Map();
  for (const match of matches) for (const player of match.players || []) {
    const entry = entries.get(player.name) || { name: player.name, score: 0, wins: 0, games: 0 };
    entry.score += player.score;
    entry.games += 1;
    if (player.place === 1) entry.wins += 1;
    entries.set(player.name, entry);
  }
  return [...entries.values()].sort((left, right) => left.score - right.score || right.wins - left.wins).slice(0, 30);
}

function renderHome() {
  const stats = getStats();
  $('#home-coins').textContent = String(data.coins);
  $('#home-record').textContent = stats.games ? `${stats.games} 対戦 · ${stats.wins} 勝` : 'まだ対戦記録がありません';
  const today = new Date().toISOString().slice(0, 10);
  const button = $('#daily-bonus');
  button.disabled = data.lastDailyBonus === today;
  button.textContent = button.disabled ? '受取済み' : '+20 受け取る';
}

function renderStats() {
  const stats = getStats();
  const winRate = stats.games ? `${(stats.wins / stats.games * 100).toFixed(1)}%` : '0.0%';
  const values = [
    ['総対戦数', stats.games], ['勝利数', stats.wins], ['敗北数', stats.losses], ['勝率', winRate],
    ['1位', stats.placements[0]], ['2位', stats.placements[1]], ['3位', stats.placements[2]], ['4位', stats.placements[3]],
    ['最高得点', stats.highestScore ?? '—'], ['最低得点', stats.lowestScore ?? '—'], ['累計プレイ時間', formatDuration(stats.playSeconds)], ['所持コイン', data.coins],
  ];
  $('#stats-grid').innerHTML = values.map(([label, value]) => `<div class="stat-cell"><small>${label}</small><strong>${value}</strong></div>`).join('');
  $('#history-count').textContent = `${stats.games} GAMES`;
  $('#history-list').innerHTML = data.history.length ? data.history.slice(0, 12).map((match) => {
    const self = match.players?.find((player) => player.isSelf);
    return `<div class="history-row"><time>${new Date(match.date).toLocaleDateString('ja-JP')}</time><strong>${match.mode === 'local' ? 'ローカル' : 'CPU'}対戦</strong><span>${self?.place ?? '-'}位</span><span>${self?.score ?? '-'} pt</span></div>`;
  }).join('') : '<div class="empty-state">対戦結果はここに保存されます。</div>';
}

function renderRankings() {
  const entries = getRankingEntries(rankingPeriod);
  $('#leaderboard').innerHTML = entries.length ? `<div class="leader-row header"><span>順位</span><span>プレイヤー名</span><span>合計スコア</span><span>勝利</span><span>対戦</span></div>${entries.map((entry, index) => `<div class="leader-row"><span class="rank">${index + 1}</span><span class="leader-name">${escapeHtml(entry.name)}</span><span>${entry.score}</span><span>${entry.wins}</span><span>${entry.games}</span></div>`).join('')}` : '<div class="empty-state">この期間の対戦結果はまだありません。</div>';
  $$('[data-period]').forEach((button) => button.classList.toggle('is-active', button.dataset.period === rankingPeriod));
}

function renderSkins() {
  $('#skin-coins').textContent = String(data.coins);
  $('#active-card-skin').textContent = CARD_SKINS.find((skin) => skin.id === data.activeCardSkin)?.name || 'Standard';
  $('#active-table-skin').textContent = TABLE_SKINS.find((skin) => skin.id === data.activeTableSkin)?.name || 'Green Table';
  const renderSet = (items, ownedIds, activeId, kind) => items.map((skin) => {
    const owned = ownedIds.includes(skin.id);
    const active = activeId === skin.id;
    const action = skin.premium ? 'STORE' : owned ? active ? '選択中' : '適用' : `${skin.price} COIN`;
    return `<button class="skin-option ${active ? 'is-active' : ''}" type="button" data-skin-kind="${kind}" data-skin-id="${skin.id}" style="--swatch:${skin.color}"><span class="skin-swatch">${kind === 'card' ? 'A♥' : '♠'}</span><strong>${skin.name}</strong><small>${action}</small></button>`;
  }).join('');
  $('#card-skin-list').innerHTML = renderSet(CARD_SKINS, data.cardSkins, data.activeCardSkin, 'card');
  $('#table-skin-list').innerHTML = renderSet(TABLE_SKINS, data.tableSkins, data.activeTableSkin, 'table');
  $$('.skin-option').forEach((button) => button.addEventListener('click', () => useSkin(button.dataset.skinKind, button.dataset.skinId)));
}

function useSkin(kind, id) {
  const catalog = kind === 'card' ? CARD_SKINS : TABLE_SKINS;
  const owned = kind === 'card' ? data.cardSkins : data.tableSkins;
  const skin = catalog.find((item) => item.id === id);
  if (!skin) return;
  if (skin.premium) return showToast('プレミアム購入はストア接続後に利用できます');
  if (!owned.includes(id)) {
    if (data.coins < skin.price) return showToast('コインが足りません');
    data.coins -= skin.price;
    owned.push(id);
    showToast(`${skin.name}を解放しました`);
  }
  if (kind === 'card') data.activeCardSkin = id;
  else data.activeTableSkin = id;
  applySkins();
  saveData();
  renderSkins();
}

function applySkins() {
  document.body.classList.remove('card-skin-dark', 'card-skin-classic', 'card-skin-neon', 'card-skin-premium', 'table-skin-blue', 'table-skin-dark', 'table-skin-casino');
  if (data.activeCardSkin !== 'standard') document.body.classList.add(`card-skin-${data.activeCardSkin}`);
  if (data.activeTableSkin !== 'green') document.body.classList.add(`table-skin-${data.activeTableSkin}`);
}

function renderSettings() {
  $('#settings-name').value = data.profile.name;
  $('#setting-bgm').checked = data.settings.bgm;
  $('#setting-sfx').checked = data.settings.sfx;
  $('#setting-vibration').checked = data.settings.vibration;
  $('#setting-notifications').checked = data.settings.notifications;
}

function updateSetting(key, value) {
  data.settings[key] = value;
  saveData();
}

function openTutorial(returnView = 'home') {
  tutorialIndex = 0;
  tutorialReturnView = returnView;
  renderTutorial();
  showView('tutorial');
}

function continueInitialView() {
  if (pendingInvitePassphrase) {
    showView('online');
    showOnlinePanel('join');
    connectOnline();
  } else if (!data.tutorialComplete) openTutorial(initialPageView);
  else {
    showView(initialPageView);
    if (initialPageView === 'online') connectOnline();
  }
}

function renderTutorial() {
  const [title, copy] = TUTORIAL_STEPS[tutorialIndex];
  $('#tutorial-step-label').textContent = `TUTORIAL / STEP ${String(tutorialIndex + 1).padStart(2, '0')}`;
  $('#tutorial-number').textContent = String(tutorialIndex + 1).padStart(2, '0');
  $('#tutorial-title').textContent = title;
  $('#tutorial-copy').textContent = copy;
  $('#tutorial-progress').innerHTML = TUTORIAL_STEPS.map((_, index) => `<span class="tutorial-dot ${index === tutorialIndex ? 'is-current' : ''}"></span>`).join('');
  $('#tutorial-next').querySelector('span:first-child').textContent = tutorialIndex === TUTORIAL_STEPS.length - 1 ? '完了' : '次へ';
}

function finishTutorial() {
  data.tutorialComplete = true;
  saveData();
  showView(tutorialReturnView);
  if (tutorialReturnView === 'online') connectOnline();
}

function returnToHome() {
  clearTimeout(cpuTimer);
  if (turnTimerInterval) clearInterval(turnTimerInterval);
  turnTimerInterval = null;
  if (game?.mode === 'online') sendOnlineMessage({ type: 'room.leave' });
  game = null;
  selectedAction = null;
  busy = false;
  showView('home');
}

function exportSaveData() {
  const exportableData = { ...data };
  delete exportableData.onlineSession;
  const blob = new Blob([JSON.stringify({ version: 2, data: exportableData }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'fourcard-save.json';
  anchor.click();
  URL.revokeObjectURL(url);
}

async function importSaveData(file) {
  try {
    const parsed = JSON.parse(await file.text());
    const incoming = parsed.version === 2 ? parsed.data : parsed;
    if (!incoming || !Array.isArray(incoming.history) || typeof incoming.coins !== 'number' || !incoming.profile) throw new Error('Invalid save file');
    const onlineSession = data.onlineSession;
    data = { ...freshData(), ...incoming, onlineSession, settings: { ...freshData().settings, ...incoming.settings } };
    saveData();
    applySkins();
    renderHome();
    showToast('セーブデータを読み込みました');
  } catch {
    showToast('読み込めるセーブデータではありません');
  }
}

function normalizeName(value, fallback) {
  const name = String(value || '').trim().slice(0, 12);
  return name || fallback;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}分` : `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2000);
}

function playEffect(type) {
  if (data.settings.vibration && navigator.vibrate) navigator.vibrate(type === 'win' ? [45, 30, 75] : 22);
  if (!data.settings.sfx) return;
  try {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = type === 'win' ? 660 : 420;
    gain.gain.setValueAtTime(0.045, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.12);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.13);
    oscillator.onended = () => context.close();
  } catch { /* Audio is optional and may be blocked by the browser. */ }
}

function setBgm(enabled) {
  if (!enabled) {
    bgmNodes.forEach((node) => { try { node.stop(); } catch {} });
    bgmNodes = [];
    bgmContext?.close();
    bgmContext = null;
    return;
  }
  if (bgmContext) return;
  try {
    bgmContext = new AudioContext();
    const gain = bgmContext.createGain();
    gain.gain.value = 0.008;
    gain.connect(bgmContext.destination);
    [110, 164.81].forEach((frequency) => {
      const oscillator = bgmContext.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      oscillator.start();
      bgmNodes.push(oscillator);
    });
  } catch { showToast('このブラウザーではBGMを再生できません'); }
}

function connectOnline() {
  if (socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(socket.readyState)) return;
  let serverAddress = String(data.settings.serverUrl || '').trim();
  if (!serverAddress || /^https?:\/\/demo\.workers\.dev\/?$/i.test(serverAddress) || pendingInvitePassphrase) {
    serverAddress = ['http:', 'https:'].includes(location.protocol) ? location.origin : '';
  }
  if (!serverAddress) {
    setConnectionStatus(false, 'サーバー未設定');
    disableOnlineActions();
    return;
  }
  clearTimeout(reconnectTimer);
  if (socket) {
    const previousSocket = socket;
    socket = null;
    previousSocket.close();
  }
  data.settings.serverUrl = serverAddress;
  saveData();
  intentionalDisconnect = false;
  let url;
  try {
    const parsed = new URL(serverAddress);
    if (!['https:', 'http:', 'wss:', 'ws:'].includes(parsed.protocol)) throw new Error('Invalid protocol');
    parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : parsed.protocol === 'http:' ? 'ws:' : parsed.protocol;
    if (!parsed.pathname.endsWith('/ws')) parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/ws`;
    url = parsed.toString();
    socket = new WebSocket(url);
  } catch {
    setConnectionStatus(false, 'URLを確認してください');
    return;
  }
  setConnectionStatus(false, '接続中…');
  const activeSocket = socket;
  socket.addEventListener('open', () => {
    if (socket !== activeSocket) return;
    setConnectionStatus(true, '認証中…');
    socket.send(JSON.stringify({ type: 'session.join', name: data.profile.name, resumeToken: data.onlineSession.resumeToken }));
  });
  socket.addEventListener('message', (event) => { if (socket === activeSocket) handleOnlineMessage(event.data); });
  socket.addEventListener('close', () => {
    if (socket !== activeSocket) return;
    setConnectionStatus(false, '切断');
    disableOnlineActions();
    if (!intentionalDisconnect && data.settings.serverUrl) reconnectTimer = setTimeout(connectOnline, 3000);
  });
  socket.addEventListener('error', () => { if (socket === activeSocket) setConnectionStatus(false, '接続エラー'); });
}

function handleOnlineMessage(raw) {
  let message;
  try { message = JSON.parse(raw); } catch { return; }
  if (message.type === 'session.ready') {
    data.onlineSession = { playerId: message.playerId, resumeToken: message.resumeToken };
    saveData();
    setConnectionStatus(true, '接続中');
    $('#choose-create-room').disabled = false;
    $('#choose-join-room').disabled = false;
    $('#quick-match').disabled = false;
    $('#create-room').disabled = false;
    $('#join-room-form button').disabled = false;
    $('#cancel-match').disabled = false;
    if (pendingInvitePassphrase) {
      $('#join-passphrase').value = pendingInvitePassphrase;
      pendingInvitePassphrase = '';
      const inviteUrl = new URL(location.href);
      inviteUrl.searchParams.delete('room');
      history.replaceState(null, '', inviteUrl);
    }
  } else if (message.type === 'room.created') {
    $('#matchmaking-status').classList.add('hidden');
    onlineRoomHost = true;
    updateOnlineLobby(message.roomId, message.players, message.maxPlayers, message.hostId, message.passphrase, message.settings);
    showToast('ルームを作成しました。合言葉を共有してください');
  } else if (message.type === 'match.queued') {
    $('#matchmaking-message').textContent = '公開中のホスト募集を待っています…';
    $('#matchmaking-status').classList.remove('hidden');
    $('#join-actions').classList.add('hidden');
    $('#join-setup .online-back').disabled = true;
    $('#quick-match').disabled = true;
    showToast('対戦相手を探しています…');
  } else if (message.type === 'match.found') {
    $('#matchmaking-status').classList.add('hidden');
    $('#online-lobby').classList.add('hidden');
    showOnlinePanel('choices');
  } else if (message.type === 'room.joined') {
    $('#matchmaking-status').classList.add('hidden');
    onlineRoomHost = message.hostId === data.onlineSession.playerId;
    updateOnlineLobby(message.roomId, message.players, message.maxPlayers, message.hostId, message.passphrase, message.settings);
    showToast('ルームに参加しました');
  } else if (message.type === 'room.started') {
    showOnlinePanel('choices');
    showToast('対戦を開始します');
  } else if (message.type === 'room.updated') {
    updateOnlineLobby(message.roomId, message.players, message.maxPlayers, message.hostId, message.passphrase, message.settings);
  } else if (message.type === 'turn.timeout') {
    showToast(`${message.playerName}の時間切れ。CPUが代わりに操作しました`);
  } else if (message.type === 'match.cancelled' || message.type === 'room.left') {
    $('#matchmaking-status').classList.add('hidden');
    $('#join-actions').classList.remove('hidden');
    $('#join-setup .online-back').disabled = false;
    $('#quick-match').disabled = false;
    showOnlinePanel(message.type === 'room.left' ? 'choices' : 'join');
  } else if (message.type === 'game.state') {
    applyOnlineState(message.state);
  } else if (message.type === 'connection.lost' || message.type === 'connection.cpu') {
    const player = game?.mode === 'online' ? game.players.find((entry) => entry.id === message.playerId) : null;
    if (player) {
      player.connected = false;
      if (message.type === 'connection.cpu') player.isCPU = true;
      renderOpponents();
    }
    showToast(message.message || 'プレイヤーの接続状態が変わりました');
  } else if (message.type === 'error') {
    busy = false;
    if (game?.mode === 'online') renderGame();
    showToast(message.message || 'オンライン処理に失敗しました');
  } else if (message.type === 'connection.resume') {
    setConnectionStatus(true, '再接続しました');
  }
}

function updateOnlineLobby(roomId, players, maxPlayers, hostId, passphrase, settings = {}) {
  onlineRoomHost = hostId === data.onlineSession.playerId;
  showOnlinePanel('lobby');
  $('#online-room-label').textContent = '対戦待機中';
  $('#online-lobby').dataset.hostId = hostId || '';
  $('#online-lobby').dataset.roomId = roomId || '';
  $('#lobby-passphrase').textContent = passphrase || roomId || '-----';
  const inviteUrl = new URL(location.href);
  inviteUrl.searchParams.set('room', passphrase || roomId || '');
  inviteUrl.hash = '';
  const qrCode = qrcode(0, 'M');
  qrCode.addData(inviteUrl.toString());
  qrCode.make();
  $('#lobby-qr-code').src = qrCode.createDataURL(4, 4);
  $('#online-room-status').textContent = `${players.map((player) => player.name).join('、')}　${players.length} / ${maxPlayers} 人${players.length >= maxPlayers ? '。満員です。' : '。参加者を待っています。'}`;
  $('#turn-time-limit').value = String(settings.turnTimeSeconds ?? 60);
  $('#fallback-difficulty').value = settings.cpuDifficulty || 'normal';
  $('#lobby-rule-settings').disabled = !onlineRoomHost;
  $('#start-room').classList.toggle('hidden', !onlineRoomHost);
  $('#start-room').disabled = !onlineRoomHost || players.length < 2;
}

function showOnlinePanel(panel) {
  const panels = { choices: '#online-choices', host: '#host-setup', join: '#join-setup', lobby: '#online-lobby' };
  for (const [name, selector] of Object.entries(panels)) $(selector).classList.toggle('hidden', name !== panel);
}

function fromServerCard(card) {
  if (!card) return null;
  const suits = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const suit = suits[card.suit] || card.suit;
  return { ...card, suit, color: card.color || (card.suit === 'H' || card.suit === 'D' ? 'red-suit' : 'black-suit'), id: `${suit}-${card.rank}` };
}

function applyOnlineState(state) {
  if (!state || !Array.isArray(state.players)) return;
  const meIndex = state.players.findIndex((player) => player.id === data.onlineSession.playerId);
  if (meIndex < 0) return;
  const wasComplete = game?.mode === 'online' && game.complete;
  game = {
    id: state.roomId,
    mode: 'online',
    players: state.players.map((player) => ({
      ...player,
      cards: player.cards.map((slot) => ({ ...slot, card: fromServerCard(slot.card) })),
    })),
    current: state.currentIndex,
    meIndex,
    discard: fromServerCard(state.discard),
    deck: Array.from({ length: state.deckCount }, () => null),
    complete: state.status === 'complete',
    startedAt: state.startedAt || onlineStartedAt || Date.now(),
    turnTimeSeconds: state.settings?.turnTimeSeconds || 0,
    turnDeadline: state.turnDeadline || null,
    waste: [],
  };
  onlineStartedAt = game.startedAt;
  busy = false;
  selectedAction = null;
  if (game.complete) {
    if (!wasComplete) finishOnlineGame();
    return;
  }
  showView('game');
  renderGame();
}

function finishOnlineGame() {
  if (turnTimerInterval) clearInterval(turnTimerInterval);
  turnTimerInterval = null;
  const ranked = [...game.players].sort((left, right) => left.score - right.score);
  const self = ranked.find((player) => player.id === data.onlineSession.playerId);
  const reward = 5 + (self?.place === 1 ? 15 : 0);
  const alreadyRecorded = data.history.some((record) => record.id === game.id && record.mode === 'online');
  if (!alreadyRecorded) {
    data.history.unshift({
      id: game.id,
      date: new Date().toISOString(),
      mode: 'online',
      duration: Math.max(1, Math.round((Date.now() - game.startedAt) / 1000)),
      players: ranked.map((player) => ({ name: player.name, score: player.score, place: player.place, isSelf: player.id === data.onlineSession.playerId })),
    });
    data.history = data.history.slice(0, 500);
    data.coins += reward;
    saveData();
  }
  renderResults(ranked, alreadyRecorded ? 0 : reward, self?.place === 1 ? 0 : Math.max(1, (self?.place || ranked.length) - 1));
  showView('result');
  if (self?.place === 1) playEffect('win');
}

function setConnectionStatus(connected, message) {
  const status = $('#connection-status');
  status.classList.toggle('is-connected', connected);
  status.disabled = !connected;
  status.lastChild.textContent = ` ${message}`;
}

function disconnectOnline() {
  const activeSocket = socket;
  if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN || !window.confirm('ゲームサーバーから切断しますか？')) return;
  intentionalDisconnect = true;
  clearTimeout(reconnectTimer);
  if (game?.mode === 'online') returnToHome();
  else {
    sendOnlineMessage({ type: 'room.leave' });
    showView('home');
  }
  activeSocket.close(1000, 'Disconnected by user');
}

function disableOnlineActions() {
  $('#choose-create-room').disabled = true;
  $('#choose-join-room').disabled = true;
  $('#quick-match').disabled = true;
  $('#create-room').disabled = true;
  $('#join-room-form button').disabled = true;
  $('#cancel-match').disabled = true;
}

function sendOnlineMessage(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    showToast('先にゲームサーバーへ接続してください');
    return false;
  }
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    showToast('ゲームサーバーへ送信できませんでした');
    return false;
  }
}

$$('[data-view]').forEach((button) => button.addEventListener('click', (event) => {
  if (button instanceof HTMLAnchorElement) event.preventDefault();
  showView(button.dataset.view);
  if (button.dataset.view === 'online') {
    connectOnline();
    if (button.dataset.onlinePanel) showOnlinePanel(button.dataset.onlinePanel);
  }
}));
$('#connection-status').addEventListener('click', disconnectOnline);
window.addEventListener('popstate', () => {
  const view = Object.keys(PAGE_PATHS).find((page) => PAGE_PATHS[page] === location.pathname) || 'home';
  showView(view, false);
  if (view === 'online') connectOnline();
});
$('#choose-create-room').addEventListener('click', () => showOnlinePanel('host'));
$('#choose-join-room').addEventListener('click', () => showOnlinePanel('join'));
$$('[data-online-back]').forEach((button) => button.addEventListener('click', () => showOnlinePanel('choices')));
$$('[data-mode]').forEach((button) => button.addEventListener('click', () => beginSetup(button.dataset.mode)));
$$('[data-period]').forEach((button) => button.addEventListener('click', () => { rankingPeriod = button.dataset.period; renderRankings(); }));
playerCountInput.addEventListener('change', renderLocalNameInputs);
setupForm.addEventListener('submit', (event) => { event.preventDefault(); startGame(); });
actionButtons.forEach((button) => button.addEventListener('click', () => {
  if (button.disabled || busy) return;
  selectedAction = selectedAction === button.dataset.action ? null : button.dataset.action;
  renderHand();
  updateActionControls();
}));
$('#handoff-continue').addEventListener('click', () => { showView('game'); renderGame(); });
$('#handoff-quit').addEventListener('click', returnToHome);
$('#rules-button').addEventListener('click', () => $('#rules-dialog').showModal());
$('#quit-button').addEventListener('click', () => { if (window.confirm('このゲームを終了してホームへ戻りますか？')) returnToHome(); });
$('#rematch-button').addEventListener('click', () => {
  if (game?.mode === 'online') {
    onlineStartedAt = 0;
    showView('online');
    sendOnlineMessage({ type: 'match.quick', name: data.profile.name });
  } else beginSetup(game?.mode || 'cpu');
});
$('#title-button').addEventListener('click', returnToHome);
$('#daily-bonus').addEventListener('click', () => {
  const today = new Date().toISOString().slice(0, 10);
  if (data.lastDailyBonus === today) return;
  data.lastDailyBonus = today;
  data.coins += 20;
  saveData();
  renderHome();
  showToast('デイリーボーナス +20 COIN');
});
$('#tutorial-start').addEventListener('click', openTutorial);
$('#settings-tutorial').addEventListener('click', openTutorial);
$('#tutorial-skip').addEventListener('click', finishTutorial);
$('#tutorial-next').addEventListener('click', () => {
  if (tutorialIndex === TUTORIAL_STEPS.length - 1) return finishTutorial();
  tutorialIndex += 1;
  renderTutorial();
});
$('#settings-name').addEventListener('change', (event) => {
  data.profile.name = normalizeName(event.target.value, 'Player 1');
  playerNameInput.value = data.profile.name;
  event.target.value = data.profile.name;
  saveData();
  renderHome();
});
$('#nickname-input').addEventListener('input', (event) => event.target.setCustomValidity(''));
$('#nickname-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('#nickname-input');
  const name = normalizeName(input.value, '');
  if (!name) {
    input.setCustomValidity('ニックネームを入力してください。');
    input.reportValidity();
    return;
  }
  data.profile.name = name;
  playerNameInput.value = name;
  saveData();
  renderHome();
  $('#nickname-dialog').close();
});
$('#nickname-dialog').addEventListener('close', continueInitialView);
$('#setting-bgm').addEventListener('change', (event) => { updateSetting('bgm', event.target.checked); setBgm(event.target.checked); });
$('#setting-sfx').addEventListener('change', (event) => updateSetting('sfx', event.target.checked));
$('#setting-vibration').addEventListener('change', (event) => updateSetting('vibration', event.target.checked));
$('#setting-notifications').addEventListener('change', async (event) => {
  if (event.target.checked && 'Notification' in window) {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') event.target.checked = false;
  }
  updateSetting('notifications', event.target.checked);
});
$('#export-data').addEventListener('click', exportSaveData);
$('#import-data').addEventListener('change', (event) => { if (event.target.files[0]) importSaveData(event.target.files[0]); event.target.value = ''; });
$('#quick-match').addEventListener('click', () => sendOnlineMessage({ type: 'match.quick', name: data.profile.name }));
$('#create-room').addEventListener('click', () => sendOnlineMessage({
  type: 'room.create',
  name: data.profile.name,
  maxPlayers: Number($('#online-player-count').value),
}));
$('#join-room-form').addEventListener('submit', (event) => { event.preventDefault(); sendOnlineMessage({ type: 'room.join', passphrase: $('#join-passphrase').value.trim().toUpperCase(), name: data.profile.name }); });
$('#cancel-match').addEventListener('click', () => sendOnlineMessage({ type: 'match.cancel' }));
$('#turn-time-limit').addEventListener('change', sendRoomSettings);
$('#fallback-difficulty').addEventListener('change', sendRoomSettings);
$('#start-room').addEventListener('click', () => sendOnlineMessage({ type: 'room.start' }));
$('#leave-room').addEventListener('click', () => {
  sendOnlineMessage({ type: 'room.leave' });
  onlineRoomHost = false;
  showOnlinePanel('choices');
  showToast('ルームを退出しました');
});
$('#copy-passphrase').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#lobby-passphrase').textContent);
    showToast('合言葉をコピーしました');
  } catch {
    showToast('合言葉を画面から確認してください');
  }
});
$('#share-room-link').addEventListener('click', async () => {
  const inviteUrl = new URL(location.href);
  inviteUrl.searchParams.set('room', $('#lobby-passphrase').textContent);
  inviteUrl.hash = '';
  const shareData = { title: 'フォーカード対戦への招待', text: 'このリンクから対戦に参加できます。', url: inviteUrl.toString() };
  if (navigator.share) {
    try {
      await navigator.share(shareData);
      return;
    } catch (error) {
      if (error.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(shareData.url);
    showToast('招待リンクをコピーしました');
  } catch {
    showToast('招待リンクを共有できませんでした');
  }
});

function sendRoomSettings() {
  if (!onlineRoomHost) return;
  sendOnlineMessage({
    type: 'room.settings',
    settings: {
      turnTimeSeconds: Number($('#turn-time-limit').value),
      cpuDifficulty: $('#fallback-difficulty').value,
    },
  });
}

data.profile.name = normalizeName(data.profile.name || getStoredValue('fourcard-player-name'), 'Player 1');
playerNameInput.value = data.profile.name;
applySkins();
renderHome();
renderLocalNameInputs();
if (data.settings.bgm) setBgm(true);
if (data.settings.notifications && 'Notification' in window && Notification.permission === 'granted' && data.lastDailyBonus !== new Date().toISOString().slice(0, 10)) {
  new Notification('フォーカード', { body: '今日のデイリーボーナスを受け取れます。' });
}
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(() => {});
if (data.profile.name === 'Player 1') {
  $('#nickname-dialog').showModal();
} else continueInitialView();