import {
  BOARD_SIZE,
  BASE_ROUND_POINTS,
  SELECTION_TIME_SECONDS,
  PLAYERS,
  PHASES,
  opponentOf,
  coordToLabel,
  createInitialState,
  validateThreeConsecutiveSpots,
  getAllValidSelections,
  getValidNextSpots,
  validateBet,
  applySelection,
  resolveRound,
  advanceToNextRound,
  hashBetCommit,
  chooseBotSelection,
  chooseBotBet,
} from './game-engine.js';

// ---------------------------------------------------------------------------
// Application State
// ---------------------------------------------------------------------------
const app = {
  mode: null, // 'p2p-host' | 'p2p-guest' | 'bot' | 'local'
  myColor: PLAYERS.BLACK, // in 'local' mode, dynamically tracks active betting/selecting player
  names: {
    [PLAYERS.BLACK]: 'Black',
    [PLAYERS.WHITE]: 'White',
  },
  puterUser: null,
  peerServer: null,
  peerConn: null,
  gameState: null,

  // Selection draft (0..3 spots)
  draftSpots: [],
  selectionTimerId: null,
  selectionSecondsLeft: SELECTION_TIME_SECONDS,

  // Betting state (Commit-Reveal for P2P, or sequential for Local)
  localBet: null,          // { round, bets: [a,b,c], nonce, hash }
  remoteCommitHash: null,  // string
  remoteReveal: null,      // { round, bets: [a,b,c], nonce }
  revealSent: false,

  // Local Pass-and-Play bet buffer
  localModeBets: { black: null, white: null },
  localBettingPlayer: PLAYERS.BLACK,

  // Ready flags for advancing REVEAL -> next round
  localReadyNext: false,
  remoteReadyNext: false,

  // Rematch flags
  localRematchReq: false,
  remoteRematchReq: false,
  lastStartingSelector: PLAYERS.BLACK,

  // Chat
  activeTab: 'history',
};

// ---------------------------------------------------------------------------
// DOM References
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

const els = {
  connectionPill: $('connection-pill'),
  connectionText: $('connection-text'),
  btnAuth: $('btn-auth'),
  btnRules: $('btn-rules'),
  btnBackLobby: $('btn-back-lobby'),
  toastContainer: $('toast-container'),

  // Lobby
  lobbyView: $('lobby-view'),
  btnHost: $('btn-host'),
  hostIdle: $('host-idle'),
  hostWaiting: $('host-waiting'),
  inviteCodeDisplay: $('invite-code-display'),
  btnCopyCode: $('btn-copy-code'),
  btnCopyLink: $('btn-copy-link'),
  btnCancelHost: $('btn-cancel-host'),
  joinForm: $('join-form'),
  inputInviteCode: $('input-invite-code'),
  btnJoin: $('btn-join'),
  btnPlayBot: $('btn-play-bot'),
  btnPlayLocal: $('btn-play-local'),

  // Game View
  gameView: $('game-view'),
  cardBlack: $('card-black'),
  cardWhite: $('card-white'),
  nameBlack: $('name-black'),
  nameWhite: $('name-white'),
  youBlack: $('you-black'),
  youWhite: $('you-white'),
  roleBlack: $('role-black'),
  roleWhite: $('role-white'),
  pointsBlack: $('points-black'),
  pointsWhite: $('points-white'),
  roundNumber: $('round-number'),
  timerBox: $('timer-box'),
  timerVal: $('timer-val'),
  phaseBadge: $('phase-badge'),
  phaseMessage: $('phase-message'),
  boardSvg: $('gomoku-board'),

  // Panels
  panelSelect: $('panel-select'),
  selectTitle: $('select-title'),
  selectSubtitle: $('select-subtitle'),
  chipA: $('chip-a'),
  chipB: $('chip-b'),
  chipC: $('chip-c'),
  selectActions: $('select-actions'),
  btnClearSelection: $('btn-clear-selection'),
  btnConfirmSelection: $('btn-confirm-selection'),

  panelBet: $('panel-bet'),
  betTitle: $('bet-title'),
  betSubtitle: $('bet-subtitle'),
  betTieNote: $('bet-tie-note'),
  betInputs: [$('bet-input-0'), $('bet-input-1'), $('bet-input-2')],
  betCoords: [$('bet-coord-0'), $('bet-coord-1'), $('bet-coord-2')],
  presetMin: $('preset-min'),
  presetEven: $('preset-even'),
  presetAllin: $('preset-allin'),
  budgetSpent: $('budget-spent'),
  budgetAvail: $('budget-avail'),
  budgetRem: $('budget-rem'),
  budgetCarry: $('budget-carry'),
  budgetNext: $('budget-next'),
  betStatusNote: $('bet-status-note'),
  btnLockBet: $('btn-lock-bet'),

  panelReveal: $('panel-reveal'),
  revealTitle: $('reveal-title'),
  revealOutcomes: $('reveal-outcomes'),
  revealEconomy: $('reveal-economy'),
  revealReadyNote: $('reveal-ready-note'),
  btnNextRound: $('btn-next-round'),

  panelGameover: $('panel-gameover'),
  gameoverTitle: $('gameover-title'),
  gameoverSubtitle: $('gameover-subtitle'),
  gameoverOutcomes: $('gameover-outcomes'),
  rematchNote: $('rematch-note'),
  btnRematch: $('btn-rematch'),
  btnGameoverLobby: $('btn-gameover-lobby'),

  // Tabs
  tabHistory: $('tab-history'),
  tabChat: $('tab-chat'),
  chatUnread: $('chat-unread'),
  paneHistory: $('pane-history'),
  paneChat: $('pane-chat'),
  historyList: $('history-list'),
  chatMessages: $('chat-messages'),
  chatForm: $('chat-form'),
  chatInput: $('chat-input'),

  // Modals
  privacyModal: $('privacy-modal'),
  privacyTitle: $('privacy-title'),
  privacyDesc: $('privacy-desc'),
  btnPrivacyContinue: $('btn-privacy-continue'),
  rulesModal: $('rules-modal'),
  btnCloseRules: $('btn-close-rules'),
};

// ---------------------------------------------------------------------------
// Helpers: Toast, Status, Random Nonce
// ---------------------------------------------------------------------------
function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'error' ? 'toast-error' : kind === 'success' ? 'toast-success' : ''}`;
  el.textContent = message;
  els.toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function setConnectionStatus(state, text) {
  els.connectionPill.className = `status-pill status-${state}`;
  els.connectionText.textContent = text;
}

function generateNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hasPuterSdk() {
  return typeof window.puter !== 'undefined' && window.puter && window.puter.peer;
}

// ---------------------------------------------------------------------------
// Puter Authentication
// ---------------------------------------------------------------------------
async function refreshPuterAuth() {
  if (typeof window.puter === 'undefined' || !window.puter.auth) {
    els.btnAuth.textContent = 'Puter SDK Offline';
    els.btnAuth.disabled = true;
    return;
  }
  try {
    if (window.puter.auth.isSignedIn()) {
      const user = await window.puter.auth.getUser();
      app.puterUser = user;
      els.btnAuth.textContent = `@${user.username}`;
    } else {
      app.puterUser = null;
      els.btnAuth.textContent = 'Sign in with Puter';
    }
  } catch {
    els.btnAuth.textContent = 'Sign in with Puter';
  }
}

async function ensurePuterSignedIn() {
  if (!hasPuterSdk()) {
    toast('Puter.js SDK is not loaded. Check your internet connection or play Practice mode.', 'error');
    return false;
  }
  try {
    if (!window.puter.auth.isSignedIn()) {
      await window.puter.auth.signIn();
    }
    const user = await window.puter.auth.getUser();
    app.puterUser = user;
    els.btnAuth.textContent = `@${user.username}`;
    return true;
  } catch (err) {
    toast(`Puter sign-in failed: ${err?.message || err}`, 'error');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Puter.js Peer-to-Peer Networking
// ---------------------------------------------------------------------------
function sendPeer(payload) {
  if (!app.peerConn) return;
  try {
    app.peerConn.send(JSON.stringify(payload));
  } catch (err) {
    toast(`Failed to send message: ${err?.message || err}`, 'error');
  }
}

async function startHosting() {
  if (!(await ensurePuterSignedIn())) return;

  els.btnHost.disabled = true;
  els.btnHost.textContent = 'Creating Room…';

  try {
    const server = await window.puter.peer.serve();
    app.peerServer = server;
    app.mode = 'p2p-host';
    app.myColor = PLAYERS.BLACK;

    const code = server.inviteCode;
    els.inviteCodeDisplay.textContent = code;
    els.hostIdle.classList.add('hidden');
    els.hostWaiting.classList.remove('hidden');
    setConnectionStatus('waiting', 'Waiting for peer…');
    toast('Room created! Share the invite code with your opponent.', 'success');

    server.addEventListener('connection', (event) => {
      const conn = event.conn;
      const remoteUser = event.user;

      if (app.peerConn) {
        try {
          conn.close('Match room is already full.');
        } catch {
          // ignore
        }
        return;
      }

      app.peerConn = conn;
      const hostName = app.puterUser?.username || 'Host';
      const guestName = remoteUser?.username || 'Guest';
      app.names[PLAYERS.BLACK] = hostName;
      app.names[PLAYERS.WHITE] = guestName;

      attachPeerConnectionHandlers(conn, () => {
        setConnectionStatus('connected', `P2P · @${guestName}`);
        sendPeer({
          type: 'START',
          startingSelector: PLAYERS.BLACK,
          hostName,
          guestName,
        });
        startNewMatch(PLAYERS.BLACK);
        toast(`@${guestName} connected! Match started.`, 'success');
      });
    });
  } catch (err) {
    toast(`Could not start Puter Peer server: ${err?.message || err}`, 'error');
    resetHostUi();
  } finally {
    els.btnHost.disabled = false;
    els.btnHost.textContent = 'Create P2P Room';
  }
}

async function joinMatch(inviteCode) {
  const cleanCode = inviteCode.trim();
  if (!cleanCode) return;
  if (!(await ensurePuterSignedIn())) return;

  els.btnJoin.disabled = true;
  els.btnJoin.textContent = 'Connecting…';
  setConnectionStatus('waiting', 'Connecting…');

  try {
    const conn = await window.puter.peer.connect(cleanCode);
    app.peerConn = conn;
    app.mode = 'p2p-guest';
    app.myColor = PLAYERS.WHITE;

    attachPeerConnectionHandlers(conn, () => {
      setConnectionStatus('connected', 'P2P · Connected');
      sendPeer({
        type: 'HELLO',
        username: app.puterUser?.username || 'Guest',
      });
      toast('Connected to host! Waiting for match start…', 'success');
    });
  } catch (err) {
    toast(`Connection failed: ${err?.message || err}`, 'error');
    setConnectionStatus('error', 'Connection failed');
    app.peerConn = null;
    app.mode = null;
  } finally {
    els.btnJoin.disabled = false;
    els.btnJoin.textContent = 'Connect & Join';
  }
}

function attachPeerConnectionHandlers(conn, onOpen) {
  conn.addEventListener('open', () => {
    onOpen();
  });

  conn.addEventListener('message', (event) => {
    let msg;
    try {
      msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    } catch {
      return;
    }
    handlePeerMessage(msg);
  });

  conn.addEventListener('error', (err) => {
    const reason = err?.code || err?.message || 'Peer connection error';
    toast(`Peer error: ${reason}`, 'error');
    setConnectionStatus('error', 'Error');
  });

  conn.addEventListener('close', (event) => {
    const reason = event?.reason ? ` (${event.reason})` : '';
    toast(`Peer disconnected${reason}.`, 'error');
    setConnectionStatus('error', 'Disconnected');
    app.peerConn = null;
  });
}

async function handlePeerMessage(msg) {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'HELLO': {
      if (msg.username && app.mode === 'p2p-host') {
        app.names[PLAYERS.WHITE] = msg.username;
        renderAll();
      }
      break;
    }

    case 'START': {
      app.names[PLAYERS.BLACK] = msg.hostName || 'Host';
      app.names[PLAYERS.WHITE] = msg.guestName || app.puterUser?.username || 'Guest';
      setConnectionStatus('connected', `P2P · @${app.names[PLAYERS.BLACK]}`);
      startNewMatch(msg.startingSelector || PLAYERS.BLACK);
      break;
    }

    case 'SELECT': {
      if (!app.gameState || app.gameState.phase !== PHASES.SELECT) return;
      if (msg.round !== app.gameState.round) return;
      try {
        stopSelectionTimer();
        app.gameState = applySelection(app.gameState, msg.spots);
        resetRoundBetState();
        renderAll();
        toast('Opponent selected 3 spots. Time to place your secret bet!', 'info');
      } catch (err) {
        toast(`Invalid selection received: ${err.message}`, 'error');
      }
      break;
    }

    case 'BET_COMMIT': {
      if (!app.gameState || app.gameState.phase !== PHASES.BET) return;
      if (msg.round !== app.gameState.round) return;
      app.remoteCommitHash = msg.hash;
      renderPlayersBar();
      renderControlPanel();
      maybeSendReveal();
      break;
    }

    case 'BET_REVEAL': {
      if (!app.gameState || app.gameState.phase !== PHASES.BET) return;
      if (msg.round !== app.gameState.round) return;
      if (!app.remoteCommitHash) {
        toast('Received bet reveal without commit.', 'error');
        return;
      }
      const expectedHash = await hashBetCommit(msg.round, msg.bets, msg.nonce);
      if (expectedHash !== app.remoteCommitHash) {
        toast('Security warning: opponent bet did not match their commit hash!', 'error');
        return;
      }
      const remoteColor = opponentOf(app.myColor);
      const valid = validateBet(msg.bets, app.gameState.points[remoteColor]);
      if (!valid.valid) {
        toast(`Invalid opponent bet: ${valid.error}`, 'error');
        return;
      }
      app.remoteReveal = msg;
      tryResolveP2pBets();
      break;
    }

    case 'NEXT_ROUND_READY': {
      if (!app.gameState || app.gameState.phase !== PHASES.REVEAL) return;
      if (msg.round !== app.gameState.round) return;
      app.remoteReadyNext = true;
      if (app.localReadyNext) {
        proceedToNextRound();
      } else {
        renderPlayersBar();
      renderControlPanel();
      }
      break;
    }

    case 'REMATCH_REQUEST': {
      app.remoteRematchReq = true;
      if (app.localRematchReq) {
        executeRematch();
      } else {
        toast('Opponent wants a rematch!', 'info');
        renderPlayersBar();
      renderControlPanel();
      }
      break;
    }

    case 'CHAT': {
      appendChatMessage(msg.sender || 'Opponent', msg.text || '', false);
      break;
    }
  }
}

function maybeSendReveal() {
  if (app.localBet && app.remoteCommitHash && !app.revealSent) {
    app.revealSent = true;
    sendPeer({
      type: 'BET_REVEAL',
      round: app.localBet.round,
      bets: app.localBet.bets,
      nonce: app.localBet.nonce,
    });
  }
  tryResolveP2pBets();
}

function tryResolveP2pBets() {
  if (!app.localBet || !app.remoteReveal) return;
  const bets = {
    [app.myColor]: app.localBet.bets,
    [opponentOf(app.myColor)]: app.remoteReveal.bets,
  };
  applyRoundResolution(bets);
}

// ---------------------------------------------------------------------------
// Match Lifecycle
// ---------------------------------------------------------------------------
function startNewMatch(startingSelector = PLAYERS.BLACK) {
  app.lastStartingSelector = startingSelector;
  app.gameState = createInitialState({ startingSelector });
  app.draftSpots = [];
  app.localRematchReq = false;
  app.remoteRematchReq = false;
  resetRoundBetState();

  els.lobbyView.classList.add('hidden');
  els.gameView.classList.remove('hidden');
  els.btnBackLobby.classList.remove('hidden');

  if (app.mode === 'bot' || app.mode === 'local') {
    els.chatInput.disabled = true;
    els.chatInput.placeholder = 'Chat is available in Puter.js P2P matches';
  } else {
    els.chatInput.disabled = false;
    els.chatInput.placeholder = 'Send a message…';
  }

  renderAll();
  onEnterSelectPhase();
}

function resetRoundBetState() {
  app.localBet = null;
  app.remoteCommitHash = null;
  app.remoteReveal = null;
  app.revealSent = false;
  app.localReadyNext = false;
  app.remoteReadyNext = false;
  app.localModeBets = { black: null, white: null };
  app.localBettingPlayer = PLAYERS.BLACK;
  resetBetInputs();
}

function resetBetInputs() {
  for (const inp of els.betInputs) {
    inp.value = '1';
    inp.disabled = false;
  }
  document.querySelectorAll('.step-btn').forEach((b) => (b.disabled = false));
  els.presetMin.disabled = false;
  els.presetEven.disabled = false;
  els.presetAllin.disabled = false;
  els.btnLockBet.disabled = false;
}

function onEnterSelectPhase() {
  app.draftSpots = [];
  startSelectionTimer();

  // If playing vs Bot and Bot is the selector, schedule bot selection
  if (app.mode === 'bot' && app.gameState.selector === PLAYERS.WHITE) {
    setTimeout(() => {
      if (!app.gameState || app.gameState.phase !== PHASES.SELECT) return;
      const botSpots = chooseBotSelection(app.gameState.board, PLAYERS.WHITE);
      if (botSpots) {
        stopSelectionTimer();
        app.gameState = applySelection(app.gameState, botSpots);
        resetRoundBetState();
        renderAll();
        toast('AI Bot selected 3 spots. Place your secret bet!', 'info');
      }
    }, 900);
  }
}

function startSelectionTimer() {
  stopSelectionTimer();
  app.selectionSecondsLeft = SELECTION_TIME_SECONDS;
  updateTimerUi();

  app.selectionTimerId = setInterval(() => {
    app.selectionSecondsLeft -= 1;
    updateTimerUi();

    if (app.selectionSecondsLeft <= 0) {
      stopSelectionTimer();
      // Auto-select if we control the current selector
      if (canLocalPlayerSelect()) {
        const all = getAllValidSelections(app.gameState.board);
        if (all.length > 0) {
          const randomLine = all[Math.floor(Math.random() * all.length)];
          toast('Selection timer expired — auto-selected 3 spots.', 'error');
          confirmSelectionSpots(randomLine);
        }
      }
    }
  }, 1000);
}

function stopSelectionTimer() {
  if (app.selectionTimerId) {
    clearInterval(app.selectionTimerId);
    app.selectionTimerId = null;
  }
}

function updateTimerUi() {
  if (!app.gameState || app.gameState.phase !== PHASES.SELECT) {
    els.timerBox.classList.add('hidden');
    return;
  }
  els.timerBox.classList.remove('hidden');
  els.timerVal.textContent = `${Math.max(0, app.selectionSecondsLeft)}s`;
  els.timerBox.classList.toggle('timer-urgent', app.selectionSecondsLeft <= 15);
}

function canLocalPlayerSelect() {
  if (!app.gameState || app.gameState.phase !== PHASES.SELECT) return false;
  if (app.mode === 'local') return true;
  return app.gameState.selector === app.myColor;
}

function activeBettingColor() {
  if (app.mode === 'local') return app.localBettingPlayer;
  return app.myColor;
}

// ---------------------------------------------------------------------------
// Selection Actions
// ---------------------------------------------------------------------------
function handleBoardClick(r, c) {
  if (!canLocalPlayerSelect()) return;

  // Clicking an already-picked spot removes it
  const existingIdx = app.draftSpots.findIndex((s) => s.r === r && s.c === c);
  if (existingIdx !== -1) {
    app.draftSpots.splice(existingIdx, 1);
    renderBoard();
    renderSelectPanel();
    return;
  }

  if (app.draftSpots.length >= 3) return;

  const validNext = getValidNextSpots(app.gameState.board, app.draftSpots);
  if (!validNext.has(`${r},${c}`)) return;

  app.draftSpots.push({ r, c });
  renderBoard();
  renderSelectPanel();
}

function confirmSelectionSpots(spots) {
  const check = validateThreeConsecutiveSpots(app.gameState.board, spots);
  if (!check.valid) {
    toast(check.error, 'error');
    return;
  }
  stopSelectionTimer();
  const round = app.gameState.round;
  app.gameState = applySelection(app.gameState, check.ordered);
  app.draftSpots = [];
  resetRoundBetState();

  if (app.mode === 'p2p-host' || app.mode === 'p2p-guest') {
    sendPeer({
      type: 'SELECT',
      round,
      spots: check.ordered,
    });
  }

  renderAll();
}

// ---------------------------------------------------------------------------
// Betting Actions
// ---------------------------------------------------------------------------
function getCurrentInputBets() {
  return els.betInputs.map((inp) => parseInt(inp.value, 10) || 0);
}

function updateBudgetDisplay() {
  if (!app.gameState) return;
  const color = activeBettingColor();
  const avail = app.gameState.points[color];
  const bets = getCurrentInputBets();
  const total = bets[0] + bets[1] + bets[2];
  const valid = validateBet(bets, avail);

  els.budgetAvail.textContent = String(avail);
  els.budgetSpent.textContent = String(total);

  if (valid.valid) {
    els.budgetRem.textContent = String(valid.remaining);
    els.budgetCarry.textContent = String(valid.carryOver);
    els.budgetNext.textContent = `${BASE_ROUND_POINTS + valid.carryOver} pts`;
    els.btnLockBet.disabled = Boolean(app.localBet);
  } else {
    els.budgetRem.textContent = '—';
    els.budgetCarry.textContent = '—';
    els.budgetNext.textContent = '—';
    els.btnLockBet.disabled = true;
  }
}

async function lockInBet() {
  if (!app.gameState || app.gameState.phase !== PHASES.BET) return;
  const color = activeBettingColor();
  const avail = app.gameState.points[color];
  const bets = getCurrentInputBets();
  const check = validateBet(bets, avail);

  if (!check.valid) {
    toast(check.error, 'error');
    return;
  }

  // Mode: Practice vs AI Bot
  if (app.mode === 'bot') {
    const botBets = chooseBotBet(app.gameState, PLAYERS.WHITE);
    applyRoundResolution({
      [PLAYERS.BLACK]: bets,
      [PLAYERS.WHITE]: botBets,
    });
    return;
  }

  // Mode: Local 2-Player Pass & Play
  if (app.mode === 'local') {
    app.localModeBets[color] = bets;
    if (color === PLAYERS.BLACK) {
      app.localBettingPlayer = PLAYERS.WHITE;
      resetBetInputs();
      els.privacyTitle.textContent = `Hand screen to ${app.names[PLAYERS.WHITE]}`;
      els.privacyDesc.textContent = `${app.names[PLAYERS.BLACK]} locked in their secret bet. Pass the device to ${app.names[PLAYERS.WHITE]} to bid privately.`;
      els.privacyModal.classList.remove('hidden');
      renderPlayersBar();
      renderControlPanel();
    } else {
      applyRoundResolution({
        [PLAYERS.BLACK]: app.localModeBets.black,
        [PLAYERS.WHITE]: app.localModeBets.white,
      });
    }
    return;
  }

  // Mode: Puter.js P2P (Cryptographic Commit-Reveal)
  const nonce = generateNonce();
  const round = app.gameState.round;
  const hash = await hashBetCommit(round, bets, nonce);

  app.localBet = { round, bets, nonce, hash };

  // Lock UI inputs
  for (const inp of els.betInputs) inp.disabled = true;
  document.querySelectorAll('.step-btn').forEach((b) => (b.disabled = true));
  els.presetMin.disabled = true;
  els.presetEven.disabled = true;
  els.presetAllin.disabled = true;
  els.btnLockBet.disabled = true;

  sendPeer({
    type: 'BET_COMMIT',
    round,
    hash,
  });

  renderControlPanel();
  maybeSendReveal();
}

function applyRoundResolution(bets) {
  app.gameState = resolveRound(app.gameState, bets);
  renderAll();
}

function requestNextRound() {
  if (!app.gameState || app.gameState.phase !== PHASES.REVEAL) return;

  if (app.mode === 'bot' || app.mode === 'local') {
    proceedToNextRound();
    return;
  }

  app.localReadyNext = true;
  sendPeer({
    type: 'NEXT_ROUND_READY',
    round: app.gameState.round,
  });

  if (app.remoteReadyNext) {
    proceedToNextRound();
  } else {
    renderControlPanel();
  }
}

function proceedToNextRound() {
  app.gameState = advanceToNextRound(app.gameState);
  resetRoundBetState();
  renderAll();
  onEnterSelectPhase();
}

function requestRematch() {
  if (app.mode === 'bot' || app.mode === 'local') {
    startNewMatch(opponentOf(app.lastStartingSelector));
    return;
  }

  app.localRematchReq = true;
  sendPeer({ type: 'REMATCH_REQUEST' });

  if (app.remoteRematchReq) {
    executeRematch();
  } else {
    renderControlPanel();
  }
}

function executeRematch() {
  const nextStarter = opponentOf(app.lastStartingSelector);
  if (app.mode === 'p2p-host') {
    sendPeer({
      type: 'START',
      startingSelector: nextStarter,
      hostName: app.names[PLAYERS.BLACK],
      guestName: app.names[PLAYERS.WHITE],
    });
    startNewMatch(nextStarter);
  }
}

function leaveMatch() {
  stopSelectionTimer();
  if (app.peerConn) {
    try {
      app.peerConn.close('Opponent left the match.');
    } catch {
      // ignore
    }
    app.peerConn = null;
  }
  app.peerServer = null;
  app.mode = null;
  app.gameState = null;

  resetHostUi();
  els.gameView.classList.add('hidden');
  els.lobbyView.classList.remove('hidden');
  els.btnBackLobby.classList.add('hidden');
  setConnectionStatus('idle', 'Lobby');
}

function resetHostUi() {
  els.hostIdle.classList.remove('hidden');
  els.hostWaiting.classList.add('hidden');
  els.inviteCodeDisplay.textContent = '------';
}

// ---------------------------------------------------------------------------
// Rendering: Players, Banner, Board, Panels, History, Chat
// ---------------------------------------------------------------------------
function renderAll() {
  if (!app.gameState) return;
  renderPlayersBar();
  renderPhaseBanner();
  renderBoard();
  renderControlPanel();
  renderHistory();
}

function canViewPoints(color) {
  const st = app.gameState;
  if (!st) return false;
  if (st.phase === PHASES.GAME_OVER) return true;
  if (app.mode === 'local') {
    return st.phase === PHASES.BET && color === app.localBettingPlayer;
  }
  return color === app.myColor;
}

function renderPlayersBar() {
  const st = app.gameState;
  els.nameBlack.textContent = app.names[PLAYERS.BLACK];
  els.nameWhite.textContent = app.names[PLAYERS.WHITE];
  els.pointsBlack.textContent = canViewPoints(PLAYERS.BLACK)
    ? String(st.points[PLAYERS.BLACK])
    : '???';
  els.pointsWhite.textContent = canViewPoints(PLAYERS.WHITE)
    ? String(st.points[PLAYERS.WHITE])
    : '???';
  els.roundNumber.textContent = String(st.round);

  const showYou = app.mode !== 'local';
  els.youBlack.classList.toggle('hidden', !showYou || app.myColor !== PLAYERS.BLACK);
  els.youWhite.classList.toggle('hidden', !showYou || app.myColor !== PLAYERS.WHITE);

  const blackIsSel = st.selector === PLAYERS.BLACK;
  els.roleBlack.textContent = blackIsSel ? 'Selector' : 'Non-Selector · Wins Ties';
  els.roleBlack.className = `role-tag ${blackIsSel ? 'is-selector' : ''}`;
  els.roleWhite.textContent = !blackIsSel ? 'Selector' : 'Non-Selector · Wins Ties';
  els.roleWhite.className = `role-tag ${!blackIsSel ? 'is-selector' : ''}`;

  els.cardBlack.classList.toggle(
    'active-turn',
    st.phase === PHASES.SELECT && st.selector === PLAYERS.BLACK
  );
  els.cardWhite.classList.toggle(
    'active-turn',
    st.phase === PHASES.SELECT && st.selector === PLAYERS.WHITE
  );

  updateTimerUi();
}

function renderPhaseBanner() {
  const st = app.gameState;
  const selName = app.names[st.selector];

  if (st.phase === PHASES.SELECT) {
    els.phaseBadge.textContent = 'SELECT';
    els.phaseMessage.textContent = canLocalPlayerSelect()
      ? `${selName}: Pick 3 consecutive empty intersections on the board.`
      : `Waiting for ${selName} to select 3 consecutive intersections…`;
  } else if (st.phase === PHASES.BET) {
    els.phaseBadge.textContent = 'BID';
    const nonSelName = app.names[opponentOf(st.selector)];
    els.phaseMessage.textContent = `Simultaneous secret bidding! Ties go to ${nonSelName}.`;
  } else if (st.phase === PHASES.REVEAL) {
    els.phaseBadge.textContent = 'REVEAL';
    els.phaseMessage.textContent = `Round ${st.round} resolved — 3 stones placed!`;
  } else {
    els.phaseBadge.textContent = 'GAME OVER';
    if (st.winner === 'draw') {
      els.phaseMessage.textContent = 'Match ended in a Draw!';
    } else {
      els.phaseMessage.textContent = `${app.names[st.winner]} wins with 5 in a row!`;
    }
  }
}

function renderBoard() {
  const st = app.gameState;
  const svg = els.boardSvg;
  const pad = 42;
  const span = 640 - pad * 2;
  const step = span / (BOARD_SIZE - 1);

  const posX = (c) => pad + c * step;
  const posY = (r) => pad + r * step;

  const canSelect = canLocalPlayerSelect();
  const validNext = canSelect ? getValidNextSpots(st.board, app.draftSpots) : new Set();

  // Map highlighted spots (either draft during SELECT or locked during BET)
  const activeSpots =
    st.phase === PHASES.SELECT
      ? app.draftSpots
      : st.phase === PHASES.BET
        ? st.selectedSpots
        : [];
  const spotLabelMap = new Map();
  activeSpots.forEach((s, i) => spotLabelMap.set(`${s.r},${s.c}`, ['A', 'B', 'C'][i]));

  // Map last placed spots during REVEAL / GAME_OVER
  const lastPlacedSet = new Set();
  if ((st.phase === PHASES.REVEAL || st.phase === PHASES.GAME_OVER) && st.lastResolution) {
    for (const o of st.lastResolution.outcomes) {
      lastPlacedSet.add(`${o.spot.r},${o.spot.c}`);
    }
  }

  // Winning cells set
  const winSet = new Set();
  for (const line of st.winningLines || []) {
    for (const p of line) winSet.add(`${p.r},${p.c}`);
  }

  let html = `
    <defs>
      <linearGradient id="woodGrad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#d2aa70" />
        <stop offset="100%" stop-color="#b78a4e" />
      </linearGradient>
      <radialGradient id="blackStone" cx="35%" cy="30%" r="70%">
        <stop offset="0%" stop-color="#5a6170" />
        <stop offset="55%" stop-color="#191d26" />
        <stop offset="100%" stop-color="#090b0f" />
      </radialGradient>
      <radialGradient id="whiteStone" cx="35%" cy="30%" r="70%">
        <stop offset="0%" stop-color="#ffffff" />
        <stop offset="70%" stop-color="#dfe5f0" />
        <stop offset="100%" stop-color="#adb7c9" />
      </radialGradient>
      <filter id="stoneShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000" flood-opacity="0.45" />
      </filter>
    </defs>
    <rect x="0" y="0" width="640" height="640" rx="8" fill="url(#woodGrad)" />
  `;

  // Grid lines
  for (let i = 0; i < BOARD_SIZE; i++) {
    const p = pad + i * step;
    html += `<line x1="${pad}" y1="${p}" x2="${640 - pad}" y2="${p}" stroke="#4e3819" stroke-width="1.15" />`;
    html += `<line x1="${p}" y1="${pad}" x2="${p}" y2="${640 - pad}" stroke="#4e3819" stroke-width="1.15" />`;

    // Coordinates
    const colChar = String.fromCharCode(65 + i);
    const rowNum = BOARD_SIZE - i;
    html += `<text x="${p}" y="22" text-anchor="middle" font-size="11" font-weight="700" fill="#4e3819" font-family="monospace">${colChar}</text>`;
    html += `<text x="${p}" y="628" text-anchor="middle" font-size="11" font-weight="700" fill="#4e3819" font-family="monospace">${colChar}</text>`;
    html += `<text x="18" y="${p + 4}" text-anchor="middle" font-size="11" font-weight="700" fill="#4e3819" font-family="monospace">${rowNum}</text>`;
    html += `<text x="622" y="${p + 4}" text-anchor="middle" font-size="11" font-weight="700" fill="#4e3819" font-family="monospace">${rowNum}</text>`;
  }

  // Star points (hoshi)
  const stars = [
    [3, 3], [3, 11], [7, 7], [11, 3], [11, 11],
  ];
  for (const [sr, sc] of stars) {
    html += `<circle cx="${posX(sc)}" cy="${posY(sr)}" r="3.6" fill="#4e3819" />`;
  }

  // Draw winning line connector
  for (const line of st.winningLines || []) {
    const first = line[0];
    const last = line[line.length - 1];
    html += `<line x1="${posX(first.c)}" y1="${posY(first.r)}" x2="${posX(last.c)}" y2="${posY(last.r)}" stroke="#e05252" stroke-width="6" stroke-linecap="round" opacity="0.7" />`;
  }

  // Intersections: stones, selection markers, valid hints, hitboxes
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const cx = posX(c);
      const cy = posY(r);
      const key = `${r},${c}`;
      const stone = st.board[r][c];

      if (stone) {
        const fill = stone === PLAYERS.BLACK ? 'url(#blackStone)' : 'url(#whiteStone)';
        html += `<circle cx="${cx}" cy="${cy}" r="${step * 0.43}" fill="${fill}" filter="url(#stoneShadow)" />`;

        if (lastPlacedSet.has(key)) {
          html += `<circle cx="${cx}" cy="${cy}" r="${step * 0.45}" fill="none" stroke="#f5cf76" stroke-width="2.4" />`;
        }
        if (winSet.has(key)) {
          html += `<circle cx="${cx}" cy="${cy}" r="5" fill="#e05252" />`;
        }
      } else {
        // Active selected spot (A, B, C)
        if (spotLabelMap.has(key)) {
          const letter = spotLabelMap.get(key);
          html += `<circle cx="${cx}" cy="${cy}" r="${step * 0.41}" fill="rgba(20, 16, 8, 0.88)" stroke="#f5cf76" stroke-width="2.4" />`;
          html += `<text x="${cx}" y="${cy + 4.5}" text-anchor="middle" font-size="13" font-weight="800" fill="#f5cf76" font-family="sans-serif">${letter}</text>`;
        } else if (canSelect && app.draftSpots.length > 0 && app.draftSpots.length < 3 && validNext.has(key)) {
          // Subtle glowing hint for valid next intersections once 1st spot is picked
          html += `<circle cx="${cx}" cy="${cy}" r="6.5" fill="rgba(245, 207, 118, 0.72)" stroke="#4e3819" stroke-width="1" />`;
        }

        // Interactive hitbox during SELECT
        if (canSelect && (spotLabelMap.has(key) || (app.draftSpots.length < 3 && validNext.has(key)))) {
          html += `<circle class="board-hit clickable" data-r="${r}" data-c="${c}" cx="${cx}" cy="${cy}" r="${step * 0.46}" />`;
        }
      }
    }
  }

  svg.innerHTML = html;
}

function renderControlPanel() {
  const st = app.gameState;
  els.panelSelect.classList.toggle('hidden', st.phase !== PHASES.SELECT);
  els.panelBet.classList.toggle('hidden', st.phase !== PHASES.BET);
  els.panelReveal.classList.toggle('hidden', st.phase !== PHASES.REVEAL);
  els.panelGameover.classList.toggle('hidden', st.phase !== PHASES.GAME_OVER);

  if (st.phase === PHASES.SELECT) renderSelectPanel();
  else if (st.phase === PHASES.BET) renderBetPanel();
  else if (st.phase === PHASES.REVEAL) renderRevealPanel();
  else if (st.phase === PHASES.GAME_OVER) renderGameoverPanel();
}

function renderSelectPanel() {
  const canSel = canLocalPlayerSelect();
  const selName = app.names[app.gameState.selector];

  els.selectTitle.textContent = canSel
    ? `${selName}: Select 3 Spots`
    : `${selName} is Selecting…`;
  els.selectSubtitle.textContent = canSel
    ? 'Click 3 consecutive empty intersections in a straight line (horizontal, vertical, or diagonal).'
    : `Waiting for ${selName} to choose 3 consecutive intersections on the board.`;

  const chips = [els.chipA, els.chipB, els.chipC];
  const sortedDraft =
    app.draftSpots.length === 3 &&
    validateThreeConsecutiveSpots(app.gameState.board, app.draftSpots).valid
      ? validateThreeConsecutiveSpots(app.gameState.board, app.draftSpots).ordered
      : app.draftSpots;

  for (let i = 0; i < 3; i++) {
    chips[i].textContent = sortedDraft[i] ? coordToLabel(sortedDraft[i].r, sortedDraft[i].c) : '—';
  }

  els.selectActions.classList.toggle('hidden', !canSel);
  els.btnClearSelection.disabled = app.draftSpots.length === 0;
  els.btnConfirmSelection.disabled =
    app.draftSpots.length !== 3 ||
    !validateThreeConsecutiveSpots(app.gameState.board, app.draftSpots).valid;
}

function renderBetPanel() {
  const st = app.gameState;
  const color = activeBettingColor();
  const isNonSelector = color !== st.selector;

  els.betTitle.textContent =
    app.mode === 'local'
      ? `${app.names[color]}'s Secret Bet`
      : 'Secret Point Bidding';

  els.betTieNote.textContent = isNonSelector ? 'You Win Ties' : 'Opponent Wins Ties';
  els.betTieNote.className = `tie-note ${isNonSelector ? 'advantage' : ''}`;

  for (let i = 0; i < 3; i++) {
    const s = st.selectedSpots[i];
    els.betCoords[i].textContent = s ? coordToLabel(s.r, s.c) : '—';
  }

  if (app.mode === 'p2p-host' || app.mode === 'p2p-guest') {
    if (app.localBet && !app.remoteCommitHash) {
      els.betStatusNote.textContent = 'Your bet is cryptographically sealed. Waiting for opponent…';
      els.betStatusNote.classList.remove('hidden');
    } else if (!app.localBet && app.remoteCommitHash) {
      els.betStatusNote.textContent = 'Opponent has locked in their secret bet! Lock in yours to reveal.';
      els.betStatusNote.classList.remove('hidden');
    } else if (app.localBet && app.remoteCommitHash) {
      els.betStatusNote.textContent = 'Both bets locked! Verifying hashes and revealing…';
      els.betStatusNote.classList.remove('hidden');
    } else {
      els.betStatusNote.classList.add('hidden');
    }
  } else {
    els.betStatusNote.classList.add('hidden');
  }

  updateBudgetDisplay();
}

function buildOutcomesHtml(resolution, { revealAll = false } = {}) {
  return resolution.outcomes
    .map((o) => {
      const winName = app.names[o.winner];
      const tieTag = revealAll && o.wasTie ? `<span class="tie-pill">TIE</span>` : '';
      let bidsText;
      if (revealAll) {
        bidsText = `B: <strong>${o.blackBet}</strong> vs W: <strong>${o.whiteBet}</strong>`;
      } else if (app.mode === 'local') {
        bidsText = `Bids hidden`;
      } else {
        const myBet = app.myColor === PLAYERS.BLACK ? o.blackBet : o.whiteBet;
        bidsText = `Your bid: <strong>${myBet}</strong> · Opp: <strong>?</strong>`;
      }
      return `
        <div class="outcome-row">
          <div class="bet-spot-info">
            <span class="spot-letter">${o.label}</span>
            <span class="spot-coord">${o.coord}</span>
          </div>
          <div class="outcome-bids">
            ${bidsText}
          </div>
          <div class="outcome-winner">
            <span class="stone-dot ${o.winner}"></span>
            <span>${escapeHtml(winName)}</span>
            ${tieTag}
          </div>
        </div>
      `;
    })
    .join('');
}

function renderRevealPanel() {
  const res = app.gameState.lastResolution;
  if (!res) return;

  els.revealTitle.textContent = `Round ${res.round} Reveal`;
  els.revealOutcomes.innerHTML = buildOutcomesHtml(res, { revealAll: false });

  const renderEconCard = (color, label) => {
    const visible = app.mode !== 'local' && color === app.myColor;
    if (!visible) {
      return `
        <div class="econ-box">
          <strong>${escapeHtml(app.names[color])} (${label})</strong>
          Spent <strong>???</strong> · Carry <strong>???</strong><br/>
          Next Round: <strong>??? pts</strong>
        </div>
      `;
    }
    return `
      <div class="econ-box">
        <strong>${escapeHtml(app.names[color])} (${label})</strong>
        Spent ${res.spent[color]} · Saved ${res.remaining[color]} → +${res.carryOver[color]} carry<br/>
        Next Round: <strong>${res.nextPoints[color]} pts</strong>
      </div>
    `;
  };

  els.revealEconomy.innerHTML =
    renderEconCard(PLAYERS.BLACK, 'Black') + renderEconCard(PLAYERS.WHITE, 'White');

  if (app.mode === 'p2p-host' || app.mode === 'p2p-guest') {
    if (app.localReadyNext && !app.remoteReadyNext) {
      els.revealReadyNote.textContent = 'Waiting for opponent to continue to the next round…';
      els.revealReadyNote.classList.remove('hidden');
      els.btnNextRound.disabled = true;
    } else if (!app.localReadyNext && app.remoteReadyNext) {
      els.revealReadyNote.textContent = 'Opponent is ready for the next round!';
      els.revealReadyNote.classList.remove('hidden');
      els.btnNextRound.disabled = false;
    } else {
      els.revealReadyNote.classList.add('hidden');
      els.btnNextRound.disabled = false;
    }
  } else {
    els.revealReadyNote.classList.add('hidden');
    els.btnNextRound.disabled = false;
  }
}

function renderGameoverPanel() {
  const st = app.gameState;
  if (st.winner === 'draw') {
    els.gameoverTitle.textContent = 'Draw!';
    els.gameoverSubtitle.textContent = 'Both players completed 5-in-a-row simultaneously (or board full).';
  } else {
    els.gameoverTitle.textContent = `${app.names[st.winner]} Wins!`;
    els.gameoverSubtitle.textContent = `Connected 5 stones in a row in Round ${st.round}.`;
  }

  if (st.lastResolution) {
    els.gameoverOutcomes.innerHTML = buildOutcomesHtml(st.lastResolution, { revealAll: true });
  }

  if (app.mode === 'p2p-host' || app.mode === 'p2p-guest') {
    if (app.localRematchReq && !app.remoteRematchReq) {
      els.rematchNote.textContent = 'Rematch requested — waiting for opponent…';
      els.rematchNote.classList.remove('hidden');
      els.btnRematch.disabled = true;
    } else if (!app.localRematchReq && app.remoteRematchReq) {
      els.rematchNote.textContent = 'Opponent requested a rematch! Click Rematch to accept.';
      els.rematchNote.classList.remove('hidden');
      els.btnRematch.disabled = false;
    } else {
      els.rematchNote.classList.add('hidden');
      els.btnRematch.disabled = false;
    }
  } else {
    els.rematchNote.classList.add('hidden');
    els.btnRematch.disabled = false;
  }
}

function renderHistory() {
  const hist = app.gameState.history;
  if (!hist || hist.length === 0) {
    els.historyList.innerHTML = '<p class="empty-msg">No completed rounds yet.</p>';
    return;
  }
  const revealAll = app.gameState.phase === PHASES.GAME_OVER;
  els.historyList.innerHTML = hist
    .map((r) => {
      const spots = r.outcomes
        .map((o) => {
          const winCode = o.winner === PLAYERS.BLACK ? 'B' : 'W';
          const tieStr = revealAll && o.wasTie ? ' tie' : '';
          if (revealAll) {
            return `<span class="history-spot-tag">${o.coord}: ${o.blackBet}-${o.whiteBet} (${winCode}${tieStr})</span>`;
          }
          if (app.mode === 'local') {
            return `<span class="history-spot-tag">${o.coord}: ${winCode}</span>`;
          }
          const myBet = app.myColor === PLAYERS.BLACK ? o.blackBet : o.whiteBet;
          return `<span class="history-spot-tag">${o.coord}: ${myBet}-? (${winCode})</span>`;
        })
        .join('');
      return `
        <div class="history-item">
          <div class="history-item-head">
            <span>Round ${r.round}</span>
            <span>Selector: ${escapeHtml(app.names[r.selector])}</span>
          </div>
          <div class="history-spots">${spots}</div>
        </div>
      `;
    })
    .join('');
}

function appendChatMessage(sender, text, isSelf) {
  const empty = els.chatMessages.querySelector('.empty-msg');
  if (empty) empty.remove();

  const div = document.createElement('div');
  div.className = `chat-msg ${isSelf ? 'self' : ''}`;
  div.innerHTML = `
    <div class="chat-msg-sender">${escapeHtml(sender)}</div>
    <div>${escapeHtml(text)}</div>
  `;
  els.chatMessages.appendChild(div);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;

  if (!isSelf && app.activeTab !== 'chat') {
    els.chatUnread.classList.remove('hidden');
  }
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

// ---------------------------------------------------------------------------
// Event Listeners
// ---------------------------------------------------------------------------
function bindEvents() {
  els.btnAuth.addEventListener('click', ensurePuterSignedIn);
  els.btnRules.addEventListener('click', () => els.rulesModal.classList.remove('hidden'));
  els.btnCloseRules.addEventListener('click', () => els.rulesModal.classList.add('hidden'));
  els.rulesModal.addEventListener('click', (e) => {
    if (e.target === els.rulesModal) els.rulesModal.classList.add('hidden');
  });

  els.btnBackLobby.addEventListener('click', leaveMatch);
  els.btnGameoverLobby.addEventListener('click', leaveMatch);

  // Lobby: Host / Join / Practice
  els.btnHost.addEventListener('click', startHosting);
  els.btnCancelHost.addEventListener('click', () => {
    app.peerServer = null;
    app.mode = null;
    resetHostUi();
    setConnectionStatus('idle', 'Lobby');
  });

  els.btnCopyCode.addEventListener('click', async () => {
    const code = els.inviteCodeDisplay.textContent;
    try {
      await navigator.clipboard.writeText(code);
      toast('Invite code copied!', 'success');
    } catch {
      toast('Copy failed — select and copy manually.', 'error');
    }
  });

  els.btnCopyLink.addEventListener('click', async () => {
    const code = els.inviteCodeDisplay.textContent;
    const url = new URL(window.location.href);
    url.searchParams.set('join', code);
    try {
      await navigator.clipboard.writeText(url.toString());
      toast('Direct join link copied!', 'success');
    } catch {
      toast('Copy failed — copy the code instead.', 'error');
    }
  });

  els.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    joinMatch(els.inputInviteCode.value);
  });

  els.btnPlayBot.addEventListener('click', () => {
    app.mode = 'bot';
    app.myColor = PLAYERS.BLACK;
    app.names[PLAYERS.BLACK] = app.puterUser?.username || 'You';
    app.names[PLAYERS.WHITE] = 'Exile AI';
    setConnectionStatus('connected', 'Practice · vs AI');
    startNewMatch(PLAYERS.BLACK);
  });

  els.btnPlayLocal.addEventListener('click', () => {
    app.mode = 'local';
    app.myColor = PLAYERS.BLACK;
    app.names[PLAYERS.BLACK] = 'Player 1 (Black)';
    app.names[PLAYERS.WHITE] = 'Player 2 (White)';
    setConnectionStatus('connected', 'Local Pass & Play');
    startNewMatch(PLAYERS.BLACK);
  });

  // Board clicks (event delegation on SVG)
  els.boardSvg.addEventListener('click', (e) => {
    const hit = e.target.closest('.board-hit');
    if (!hit) return;
    const r = parseInt(hit.dataset.r, 10);
    const c = parseInt(hit.dataset.c, 10);
    handleBoardClick(r, c);
  });

  // Selection controls
  els.btnClearSelection.addEventListener('click', () => {
    app.draftSpots = [];
    renderBoard();
    renderSelectPanel();
  });

  els.btnConfirmSelection.addEventListener('click', () => {
    confirmSelectionSpots(app.draftSpots);
  });

  // Betting steppers & inputs
  document.querySelectorAll('.step-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      const delta = parseInt(btn.dataset.delta, 10);
      const inp = els.betInputs[idx];
      const next = Math.max(1, (parseInt(inp.value, 10) || 1) + delta);
      inp.value = String(next);
      updateBudgetDisplay();
    });
  });

  els.betInputs.forEach((inp) => {
    inp.addEventListener('input', updateBudgetDisplay);
  });

  els.presetMin.addEventListener('click', () => {
    els.betInputs.forEach((inp) => (inp.value = '1'));
    updateBudgetDisplay();
  });

  els.presetEven.addEventListener('click', () => {
    if (!app.gameState) return;
    const avail = app.gameState.points[activeBettingColor()];
    const base = Math.max(1, Math.floor(avail / 3));
    const rem = avail - base * 3;
    els.betInputs[0].value = String(base + (rem > 0 ? 1 : 0));
    els.betInputs[1].value = String(base + (rem > 1 ? 1 : 0));
    els.betInputs[2].value = String(base);
    updateBudgetDisplay();
  });

  els.presetAllin.addEventListener('click', () => {
    if (!app.gameState) return;
    const avail = app.gameState.points[activeBettingColor()];
    els.betInputs[0].value = String(Math.max(1, avail - 2));
    els.betInputs[1].value = '1';
    els.betInputs[2].value = '1';
    updateBudgetDisplay();
  });

  els.btnLockBet.addEventListener('click', lockInBet);
  els.btnNextRound.addEventListener('click', requestNextRound);
  els.btnRematch.addEventListener('click', requestRematch);

  // Privacy modal (Local Pass & Play)
  els.btnPrivacyContinue.addEventListener('click', () => {
    els.privacyModal.classList.add('hidden');
  });

  // Tabs
  els.tabHistory.addEventListener('click', () => {
    app.activeTab = 'history';
    els.tabHistory.classList.add('active');
    els.tabChat.classList.remove('active');
    els.paneHistory.classList.remove('hidden');
    els.paneChat.classList.add('hidden');
  });

  els.tabChat.addEventListener('click', () => {
    app.activeTab = 'chat';
    els.tabChat.classList.add('active');
    els.tabHistory.classList.remove('active');
    els.paneChat.classList.remove('hidden');
    els.paneHistory.classList.add('hidden');
    els.chatUnread.classList.add('hidden');
  });

  // Chat submit
  els.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = els.chatInput.value.trim();
    if (!text || !app.peerConn) return;
    const sender = app.names[app.myColor] || 'You';
    sendPeer({ type: 'CHAT', sender, text, ts: Date.now() });
    appendChatMessage(sender, text, true);
    els.chatInput.value = '';
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function init() {
  bindEvents();
  refreshPuterAuth();

  // Auto-fill invite code if arrived via ?join=CODE
  const params = new URLSearchParams(window.location.search);
  const joinCode = params.get('join');
  if (joinCode) {
    els.inputInviteCode.value = joinCode;
    toast('Invite code pre-filled from link! Click "Connect & Join" to play.', 'info');
  }
}

init();
