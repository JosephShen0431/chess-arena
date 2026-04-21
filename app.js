/* Chess Arena — peer-to-peer multiplayer chess + chat
   Uses chess.js for rules, PeerJS public broker for WebRTC signaling. */

(() => {
  const PEER_PREFIX = 'claude-chess-arena-v2-';
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const PIECE_UNICODE = {
    p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚'
  };
  const PROMOTION_PIECES = ['q', 'r', 'b', 'n'];

  /* ========= State ========= */
  const state = {
    peer: null,
    conn: null,
    isHost: false,
    roomCode: null,
    myName: 'Anonymous',
    oppName: 'Opponent',
    myColor: null,        // 'w' | 'b'
    chess: null,          // chess.js instance
    selected: null,       // square e.g. 'e2'
    legalTargets: [],     // [{to, flags, capture}]
    lastMove: null,       // {from, to}
    pending: {            // pending UX flows
      promotion: null,    // {from, to, resolve}
      confirm: null,      // {resolve}
      drawOffer: false,   // we offered draw, waiting
      drawOfferedByOpp: false,
      rematchOffer: false,
      rematchOfferedByOpp: false,
    },
    gameOver: false,
    history: [],          // SAN history mirrored for UI
  };

  /* ========= DOM ========= */
  const $ = (id) => document.getElementById(id);
  const dom = {
    lobby: $('lobby'), game: $('game'),
    nameInput: $('nameInput'),
    createBtn: $('createBtn'), joinBtn: $('joinBtn'), joinCodeInput: $('joinCodeInput'),
    lobbyHint: $('lobbyHint'),
    status: $('status'), statusText: $('statusText'),
    board: $('board'),
    topPlayer: $('topPlayer'), bottomPlayer: $('bottomPlayer'),
    topCaptured: $('topCaptured'), bottomCaptured: $('bottomCaptured'),
    roomCodeDisplay: $('roomCodeDisplay'),
    chatLog: $('chatLog'), chatForm: $('chatForm'), chatInput: $('chatInput'),
    movesLog: $('movesLog'),
    resignBtn: $('resignBtn'), drawBtn: $('drawBtn'),
    rematchBtn: $('rematchBtn'), leaveBtn: $('leaveBtn'),
    copyCodeBtn: $('copyCodeBtn'),
    resultOverlay: $('resultOverlay'), resultTitle: $('resultTitle'), resultSub: $('resultSub'),
    newGameBtn: $('newGameBtn'),
    promotionModal: $('promotionModal'), promotionChoices: $('promotionChoices'),
    confirmModal: $('confirmModal'), confirmTitle: $('confirmTitle'),
    confirmBody: $('confirmBody'), confirmYes: $('confirmYes'), confirmNo: $('confirmNo'),
    toasts: $('toasts'),
    tabs: document.querySelectorAll('.tab'),
    tabPanels: document.querySelectorAll('.tab-panel'),
  };

  /* ========= Utils ========= */
  function generateCode() {
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return code;
  }

  function normalizeCode(raw) {
    return (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  }

  function setStatus(kind, text) {
    dom.status.className = 'status ' + kind;
    dom.statusText.textContent = text;
  }

  function toast(msg, ms = 2400) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    dom.toasts.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; }, ms - 300);
    setTimeout(() => el.remove(), ms);
  }

  function confirm(title, body) {
    dom.confirmTitle.textContent = title;
    dom.confirmBody.textContent = body;
    dom.confirmModal.classList.remove('hidden');
    return new Promise((resolve) => {
      state.pending.confirm = resolve;
    });
  }
  dom.confirmYes.addEventListener('click', () => {
    dom.confirmModal.classList.add('hidden');
    if (state.pending.confirm) { state.pending.confirm(true); state.pending.confirm = null; }
  });
  dom.confirmNo.addEventListener('click', () => {
    dom.confirmModal.classList.add('hidden');
    if (state.pending.confirm) { state.pending.confirm(false); state.pending.confirm = null; }
  });

  function beep(freq = 440, dur = 0.08) {
    try {
      const ctx = beep.ctx || (beep.ctx = new (window.AudioContext || window.webkitAudioContext)());
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.value = 0.05;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      osc.stop(ctx.currentTime + dur);
    } catch (e) { /* audio unavailable */ }
  }

  /* ========= PeerJS connection ========= */
  function makePeer(id) {
    return new Peer(id, {
      debug: 1,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' },
        ],
      },
    });
  }

  function createRoom() {
    const code = generateCode();
    setStatus('connecting', 'Creating room…');
    dom.createBtn.disabled = true;
    dom.joinBtn.disabled = true;
    state.isHost = true;
    state.roomCode = code;

    const peer = makePeer(PEER_PREFIX + code);
    state.peer = peer;

    peer.on('open', () => {
      // Assign host's color up front (random)
      state.myColor = Math.random() < 0.5 ? 'w' : 'b';
      state.chess = new Chess();
      state.gameOver = true; // locked until opponent joins
      setStatus('connecting', `Room ${code} — waiting for opponent…`);
      enterGame();
      renderAll();
      addSysMessage(`Room ${code} is live. Share the code with your opponent.`);
      dom.roomCodeDisplay.textContent = code;
    });

    peer.on('connection', (conn) => {
      if (state.conn) { conn.close(); return; } // only one opponent
      setupConnection(conn);
    });

    peer.on('error', (err) => {
      console.error('Peer error:', err);
      if (err.type === 'unavailable-id') {
        setStatus('error', 'Code collision — try again');
        dom.lobbyHint.textContent = 'That code is taken. Please try again.';
        dom.createBtn.disabled = false;
        dom.joinBtn.disabled = false;
        state.peer = null;
      } else if (err.type === 'peer-unavailable') {
        // handled at join
      } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
        setStatus('error', 'Network error');
        toast('Connection lost — try reloading.');
      } else {
        setStatus('error', err.type || 'Error');
      }
    });

    peer.on('disconnected', () => {
      setStatus('connecting', 'Reconnecting…');
      try { peer.reconnect(); } catch (e) {}
    });
  }

  function joinRoom() {
    const code = normalizeCode(dom.joinCodeInput.value);
    if (code.length !== 6) {
      dom.lobbyHint.textContent = 'Enter a 6-character code.';
      return;
    }
    setStatus('connecting', 'Connecting…');
    dom.createBtn.disabled = true;
    dom.joinBtn.disabled = true;
    state.isHost = false;
    state.roomCode = code;

    const peer = makePeer(); // random id
    state.peer = peer;

    peer.on('open', () => {
      const conn = peer.connect(PEER_PREFIX + code, { reliable: true });
      setupConnection(conn);
      conn.on('open', () => {
        send({ type: 'hello', name: state.myName });
      });

      // Timeout if peer unreachable
      setTimeout(() => {
        if (!state.myColor && !state.gameOver) {
          // still not connected
          if (!conn.open) {
            toast('Could not reach that room. Double-check the code.');
            setStatus('error', 'Not connected');
            dom.lobbyHint.textContent = 'Room not found or unreachable.';
            dom.createBtn.disabled = false;
            dom.joinBtn.disabled = false;
            try { peer.destroy(); } catch (e) {}
            state.peer = null;
          }
        }
      }, 8000);
    });

    peer.on('error', (err) => {
      console.error('Peer error:', err);
      if (err.type === 'peer-unavailable') {
        dom.lobbyHint.textContent = 'Room not found. Check the code.';
        setStatus('error', 'Room not found');
        dom.createBtn.disabled = false;
        dom.joinBtn.disabled = false;
        try { peer.destroy(); } catch (e) {}
        state.peer = null;
      } else {
        setStatus('error', err.type || 'Error');
      }
    });
  }

  function setupConnection(conn) {
    state.conn = conn;
    conn.on('data', onMessage);
    conn.on('close', onDisconnected);
    conn.on('error', (err) => { console.error('Conn error:', err); });
  }

  function send(msg) {
    try { state.conn && state.conn.open && state.conn.send(msg); }
    catch (e) { console.error('send failed', e); }
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'hello': // received by host
        state.oppName = (msg.name || 'Opponent').slice(0, 20);
        // Send welcome with assigned color (guest gets opposite of host)
        const guestColor = state.myColor === 'w' ? 'b' : 'w';
        send({ type: 'welcome', name: state.myName, yourColor: guestColor });
        startNewGame();
        setStatus('connected', 'Connected');
        enterGame();
        addSysMessage(`${state.oppName} joined. Game on!`);
        break;
      case 'welcome': // received by guest
        state.oppName = (msg.name || 'Opponent').slice(0, 20);
        state.myColor = msg.yourColor;
        startNewGame();
        setStatus('connected', 'Connected');
        enterGame();
        addSysMessage(`Connected to ${state.oppName}. Game on!`);
        break;
      case 'move':
        applyOpponentMove(msg);
        break;
      case 'chat':
        addChatMessage('them', state.oppName, msg.text);
        beep(520, 0.04);
        break;
      case 'resign':
        endGame(`${state.oppName} resigned. You win.`, 'Resignation');
        break;
      case 'draw-offer':
        handleDrawOffer();
        break;
      case 'draw-accept':
        endGame('Draw by agreement.', 'Draw');
        break;
      case 'draw-decline':
        state.pending.drawOffer = false;
        addSysMessage(`${state.oppName} declined the draw.`);
        break;
      case 'rematch-offer':
        handleRematchOffer();
        break;
      case 'rematch-accept':
        state.myColor = msg.yourColor;
        startNewGame();
        addSysMessage('Rematch! New game started.');
        break;
    }
  }

  function onDisconnected() {
    setStatus('error', 'Opponent disconnected');
    addSysMessage('Opponent disconnected.');
    toast('Opponent disconnected.');
    state.gameOver = true;
    updateBoard();
  }

  /* ========= Chess game ========= */
  function startNewGame() {
    state.chess = new Chess();
    state.selected = null;
    state.legalTargets = [];
    state.lastMove = null;
    state.history = [];
    state.gameOver = false;
    state.pending.drawOffer = false;
    state.pending.drawOfferedByOpp = false;
    state.pending.rematchOffer = false;
    state.pending.rematchOfferedByOpp = false;
    dom.resultOverlay.classList.add('hidden');
    renderAll();
  }

  function applyOpponentMove(msg) {
    const move = state.chess.move({ from: msg.from, to: msg.to, promotion: msg.promotion || undefined });
    if (!move) { console.error('Invalid opponent move', msg); return; }
    state.lastMove = { from: move.from, to: move.to };
    state.history.push(move);
    beep(move.captured ? 320 : 400, 0.05);
    renderAll();
    checkGameOver();
  }

  async function tryMakeMove(from, to) {
    // Detect promotion
    const moves = state.chess.moves({ square: from, verbose: true });
    const candidate = moves.find(m => m.to === to);
    if (!candidate) return false;

    let promotion = undefined;
    if (candidate.flags.includes('p')) {
      promotion = await askPromotion();
      if (!promotion) return false; // cancelled
    }

    const move = state.chess.move({ from, to, promotion });
    if (!move) return false;

    state.lastMove = { from: move.from, to: move.to };
    state.history.push(move);
    state.selected = null;
    state.legalTargets = [];
    beep(move.captured ? 340 : 500, 0.05);
    send({ type: 'move', from: move.from, to: move.to, promotion });
    renderAll();
    checkGameOver();
    return true;
  }

  function checkGameOver() {
    if (!state.chess.game_over()) return;
    let title = 'Game over', sub = '';
    if (state.chess.in_checkmate()) {
      const loser = state.chess.turn(); // whose turn = who got mated
      const winnerColor = loser === 'w' ? 'b' : 'w';
      const winnerIsMe = winnerColor === state.myColor;
      title = 'Checkmate';
      sub = winnerIsMe ? 'You win!' : `${state.oppName} wins.`;
    } else if (state.chess.in_stalemate()) {
      title = 'Stalemate'; sub = 'Draw.';
    } else if (state.chess.insufficient_material()) {
      title = 'Draw'; sub = 'Insufficient material.';
    } else if (state.chess.in_threefold_repetition()) {
      title = 'Draw'; sub = 'Threefold repetition.';
    } else if (state.chess.in_draw()) {
      title = 'Draw'; sub = '50-move rule.';
    }
    endGame(sub || title, title);
  }

  function endGame(sub, title) {
    state.gameOver = true;
    dom.resultTitle.textContent = title || 'Game over';
    dom.resultSub.textContent = sub || '';
    dom.resultOverlay.classList.remove('hidden');
    renderAll();
    addSysMessage(`${title}${sub ? ' — ' + sub : ''}`);
  }

  /* ========= UI rendering ========= */
  function renderAll() {
    renderPlayers();
    renderBoard();
    renderMoves();
    renderCaptured();
    dom.roomCodeDisplay.textContent = state.roomCode || '——';
  }

  function renderPlayers() {
    // top = opponent, bottom = me
    dom.topPlayer.querySelector('.player-name').textContent = state.oppName || 'Opponent';
    dom.bottomPlayer.querySelector('.player-name').textContent = (state.myName || 'You') + ' (you)';
    const myInitial = (state.myName || '?').slice(0, 1).toUpperCase();
    const oppInitial = (state.oppName || '?').slice(0, 1).toUpperCase();
    dom.bottomPlayer.querySelector('.avatar').textContent = myInitial;
    dom.topPlayer.querySelector('.avatar').textContent = oppInitial;
  }

  function renderBoard() {
    if (!state.chess) return;
    const orientation = state.myColor === 'b' ? 'b' : 'w';
    const ranks = orientation === 'w' ? [8,7,6,5,4,3,2,1] : [1,2,3,4,5,6,7,8];
    const files = orientation === 'w' ? ['a','b','c','d','e','f','g','h'] : ['h','g','f','e','d','c','b','a'];
    const board = state.chess.board();
    const myTurn = state.chess.turn() === state.myColor && !state.gameOver;

    // In-check square
    let checkSquare = null;
    if (state.chess.in_check()) {
      const turn = state.chess.turn();
      outer:
      for (let r = 0; r < 8; r++) {
        for (let f = 0; f < 8; f++) {
          const sq = board[r][f];
          if (sq && sq.type === 'k' && sq.color === turn) {
            checkSquare = String.fromCharCode('a'.charCodeAt(0) + f) + (8 - r);
            break outer;
          }
        }
      }
    }

    const legalSet = new Set(state.legalTargets.map(m => m.to));

    let html = '';
    ranks.forEach((rank, ri) => {
      files.forEach((file, fi) => {
        const square = file + rank;
        const rankIdx = 8 - rank;
        const fileIdx = file.charCodeAt(0) - 'a'.charCodeAt(0);
        const piece = board[rankIdx][fileIdx];
        const isLight = (rankIdx + fileIdx) % 2 === 0;
        const classes = ['square', isLight ? 'light' : 'dark'];
        if (state.selected === square) classes.push('selected');
        if (state.lastMove && (state.lastMove.from === square || state.lastMove.to === square)) classes.push('last-move');
        if (checkSquare === square) classes.push('in-check');
        if (myTurn && piece && piece.color === state.myColor) classes.push('selectable');
        if (legalSet.has(square)) classes.push('can-target');

        let inner = '';
        if (piece) {
          const colorClass = piece.color === 'w' ? 'white' : 'black';
          inner += `<span class="piece ${colorClass}">${PIECE_UNICODE[piece.type]}</span>`;
        }
        if (legalSet.has(square)) {
          inner += piece ? '<span class="ring-capture"></span>' : '<span class="dot-move"></span>';
        }
        // Coordinates on edge squares
        if (fi === 0) inner += `<span class="coord rank">${rank}</span>`;
        if (ri === 7) inner += `<span class="coord file">${file}</span>`;

        html += `<div class="${classes.join(' ')}" data-sq="${square}">${inner}</div>`;
      });
    });
    dom.board.innerHTML = html;
  }

  function renderMoves() {
    const h = state.history;
    let html = '';
    for (let i = 0; i < h.length; i += 2) {
      const num = (i / 2) + 1;
      const white = h[i] ? h[i].san : '';
      const black = h[i+1] ? h[i+1].san : '';
      const wClass = (i === h.length - 1) ? 'mv latest' : 'mv';
      const bClass = (i + 1 === h.length - 1) ? 'mv latest' : 'mv';
      html += `<div class="move-pair"><span class="num">${num}.</span><span class="${wClass}">${white}</span><span class="${bClass}">${black}</span></div>`;
    }
    dom.movesLog.innerHTML = html;
    dom.movesLog.scrollTop = dom.movesLog.scrollHeight;
  }

  function renderCaptured() {
    // Tally captured pieces from history
    const captured = { w: [], b: [] };
    for (const m of state.history) {
      if (m.captured) {
        const victimColor = m.color === 'w' ? 'b' : 'w';
        captured[victimColor].push(m.captured);
      }
    }
    // Show opponent's captures on my row (pieces I lost) and vice versa? Classic: show your captures (opp pieces you took) near you.
    const myCaps = captured[state.myColor === 'w' ? 'b' : 'w']; // opp pieces I took
    const oppCaps = captured[state.myColor === 'w' ? 'w' : 'b'];
    dom.bottomCaptured.innerHTML = myCaps.map(t => `<span class="piece ${state.myColor === 'w' ? 'black' : 'white'}" style="font-size:16px">${PIECE_UNICODE[t]}</span>`).join(' ');
    dom.topCaptured.innerHTML = oppCaps.map(t => `<span class="piece ${state.myColor === 'w' ? 'white' : 'black'}" style="font-size:16px">${PIECE_UNICODE[t]}</span>`).join(' ');
  }

  function updateBoard() { renderBoard(); }

  /* ========= Board interaction ========= */
  dom.board.addEventListener('click', (e) => {
    const sqEl = e.target.closest('.square');
    if (!sqEl) return;
    const square = sqEl.dataset.sq;
    onSquareClick(square);
  });

  function onSquareClick(square) {
    if (!state.chess || state.gameOver) return;
    if (state.chess.turn() !== state.myColor) {
      // Not our turn — allow selecting to preview? Keep it simple, ignore.
      return;
    }
    const piece = state.chess.get(square);

    if (state.selected) {
      // If clicking same square: deselect
      if (state.selected === square) {
        state.selected = null;
        state.legalTargets = [];
        renderBoard();
        return;
      }
      // If clicking own piece, reselect
      if (piece && piece.color === state.myColor) {
        selectSquare(square);
        return;
      }
      // Else try move
      const legal = state.legalTargets.find(m => m.to === square);
      if (legal) {
        tryMakeMove(state.selected, square);
      } else {
        state.selected = null;
        state.legalTargets = [];
        renderBoard();
      }
    } else {
      if (piece && piece.color === state.myColor) selectSquare(square);
    }
  }

  function selectSquare(square) {
    state.selected = square;
    state.legalTargets = state.chess.moves({ square, verbose: true });
    renderBoard();
  }

  /* ========= Promotion ========= */
  function askPromotion() {
    return new Promise((resolve) => {
      dom.promotionChoices.innerHTML = PROMOTION_PIECES.map(p =>
        `<button data-p="${p}"><span class="piece ${state.myColor === 'w' ? 'white' : 'black'}">${PIECE_UNICODE[p]}</span></button>`
      ).join('');
      dom.promotionModal.classList.remove('hidden');
      const onClick = (e) => {
        const btn = e.target.closest('button[data-p]');
        if (!btn) return;
        dom.promotionModal.classList.add('hidden');
        dom.promotionChoices.removeEventListener('click', onClick);
        resolve(btn.dataset.p);
      };
      dom.promotionChoices.addEventListener('click', onClick);
    });
  }

  /* ========= Chat ========= */
  function addChatMessage(kind, who, text) {
    const div = document.createElement('div');
    div.className = 'chat-msg ' + kind;
    div.innerHTML = `<div class="who">${escapeHtml(who)}</div><div class="text">${escapeHtml(text)}</div>`;
    dom.chatLog.appendChild(div);
    dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
  }
  function addSysMessage(text) {
    const div = document.createElement('div');
    div.className = 'chat-msg sys';
    div.textContent = text;
    dom.chatLog.appendChild(div);
    dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
  }
  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  dom.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = dom.chatInput.value.trim().slice(0, 300);
    if (!text) return;
    if (!state.conn || !state.conn.open) { toast('Not connected.'); return; }
    send({ type: 'chat', text });
    addChatMessage('me', state.myName, text);
    dom.chatInput.value = '';
  });

  /* ========= Game controls ========= */
  dom.resignBtn.addEventListener('click', async () => {
    if (state.gameOver || !state.conn) return;
    const ok = await confirm('Resign?', 'Your opponent will win this game.');
    if (!ok) return;
    send({ type: 'resign' });
    endGame('You resigned.', 'Resignation');
  });

  dom.drawBtn.addEventListener('click', () => {
    if (state.gameOver || !state.conn) return;
    if (state.pending.drawOfferedByOpp) {
      // Accept pending offer
      send({ type: 'draw-accept' });
      endGame('Draw by agreement.', 'Draw');
      return;
    }
    if (state.pending.drawOffer) { toast('Draw already offered.'); return; }
    state.pending.drawOffer = true;
    send({ type: 'draw-offer' });
    addSysMessage('You offered a draw.');
    toast('Draw offered.');
  });

  async function handleDrawOffer() {
    state.pending.drawOfferedByOpp = true;
    addSysMessage(`${state.oppName} offers a draw.`);
    const accept = await confirm('Draw offer', `${state.oppName} is offering a draw. Accept?`);
    state.pending.drawOfferedByOpp = false;
    if (accept) {
      send({ type: 'draw-accept' });
      endGame('Draw by agreement.', 'Draw');
    } else {
      send({ type: 'draw-decline' });
      addSysMessage('You declined the draw.');
    }
  }

  dom.rematchBtn.addEventListener('click', handleRematchClick);
  dom.newGameBtn.addEventListener('click', handleRematchClick);

  function handleRematchClick() {
    if (!state.conn) return;
    if (state.pending.rematchOfferedByOpp) {
      // Accept — opponent proposed, we respond with swapped colors
      // Opponent's new color is opposite of whatever they had; since we don't track theirs, just swap ours
      const newColor = state.myColor === 'w' ? 'b' : 'w';
      const theirNewColor = newColor === 'w' ? 'b' : 'w';
      send({ type: 'rematch-accept', yourColor: theirNewColor });
      state.myColor = newColor;
      state.pending.rematchOfferedByOpp = false;
      startNewGame();
      addSysMessage('Rematch! New game started.');
      return;
    }
    if (state.pending.rematchOffer) { toast('Rematch offer pending.'); return; }
    state.pending.rematchOffer = true;
    send({ type: 'rematch-offer' });
    addSysMessage('You offered a rematch.');
    toast('Rematch offered.');
  }

  async function handleRematchOffer() {
    state.pending.rematchOfferedByOpp = true;
    addSysMessage(`${state.oppName} wants a rematch.`);
    const accept = await confirm('Rematch?', `${state.oppName} wants to play again (colors will swap).`);
    if (accept) {
      const newColor = state.myColor === 'w' ? 'b' : 'w';
      const theirNewColor = newColor === 'w' ? 'b' : 'w';
      send({ type: 'rematch-accept', yourColor: theirNewColor });
      state.myColor = newColor;
      state.pending.rematchOfferedByOpp = false;
      startNewGame();
      addSysMessage('Rematch! New game started.');
    } else {
      state.pending.rematchOfferedByOpp = false;
      addSysMessage('You declined the rematch.');
    }
  }

  dom.leaveBtn.addEventListener('click', async () => {
    const ok = await confirm('Leave game?', 'This will disconnect you from the room.');
    if (!ok) return;
    if (state.conn) try { state.conn.close(); } catch (e) {}
    if (state.peer) try { state.peer.destroy(); } catch (e) {}
    location.reload();
  });

  dom.copyCodeBtn.addEventListener('click', async () => {
    if (!state.roomCode) return;
    try {
      await navigator.clipboard.writeText(state.roomCode);
      toast('Room code copied.');
    } catch (e) {
      toast('Code: ' + state.roomCode);
    }
  });

  /* ========= Tabs ========= */
  dom.tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      dom.tabs.forEach(t => t.classList.toggle('active', t === tab));
      dom.tabPanels.forEach(p => p.classList.toggle('hidden', p.dataset.panel !== tab.dataset.tab));
    });
  });

  /* ========= Lobby actions ========= */
  dom.createBtn.addEventListener('click', () => {
    state.myName = (dom.nameInput.value.trim().slice(0, 20)) || 'Anonymous';
    dom.lobbyHint.textContent = '';
    createRoom();
  });

  dom.joinBtn.addEventListener('click', () => {
    state.myName = (dom.nameInput.value.trim().slice(0, 20)) || 'Anonymous';
    dom.lobbyHint.textContent = '';
    joinRoom();
  });

  dom.joinCodeInput.addEventListener('input', (e) => {
    e.target.value = normalizeCode(e.target.value);
  });
  dom.joinCodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') dom.joinBtn.click();
  });
  dom.nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') dom.createBtn.click();
  });

  function enterGame() {
    dom.lobby.classList.add('hidden');
    dom.game.classList.remove('hidden');
  }

  // URL ?room=XXXXXX pre-fills join code
  const params = new URLSearchParams(location.search);
  const urlRoom = normalizeCode(params.get('room') || '');
  if (urlRoom.length === 6) {
    dom.joinCodeInput.value = urlRoom;
    dom.joinCodeInput.focus();
  }

  // Persist name
  const savedName = localStorage.getItem('chess-arena-name');
  if (savedName) dom.nameInput.value = savedName;
  dom.nameInput.addEventListener('change', () => {
    localStorage.setItem('chess-arena-name', dom.nameInput.value.slice(0, 20));
  });

  setStatus('', 'Not connected');
})();
