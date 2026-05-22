'use strict';

// ══════════════════════════════════════════════════════════════════════
//  content.js — runs in PAGE WORLD (world: MAIN) at document_start
//
//  Part 1: Interceptor — patches window.Worker immediately and
//          synchronously before any page script or module executes.
//  Part 2: Solver — runs after a startup delay, reading from the
//          intercepted state and driving expectimax decisions.
// ══════════════════════════════════════════════════════════════════════

console.log('[2048-Solver] Combined content.js running in MAIN world on', window.location.href);

// ──────────────────────────────────────────────────────────────────────
//  PART 1: INTERCEPTOR
// ──────────────────────────────────────────────────────────────────────
(function () {
  if (window.__2048InterceptorReady) {
    console.log('[2048-Interceptor] Already installed.');
    return;
  }
  window.__2048InterceptorReady = true;

  window.__2048State = {
    board             : null,   // flat [16] — 0 = empty
    score             : 0,
    msgCount          : 0,      // total incoming count
    incomingCount     : 0,
    outgoingCount     : 0,
    lastUpdate        : 0,

    // Tile-tracking (reconstruct board from differential events)
    tiles             : {},     // id/key → {id, x, y, value}

    // Diagnostics - Incoming
    lastIncoming      : [],     // rolling last 50 incoming messages
    incomingTypes     : {},     // type -> count
    eventNames        : {},     // eventName -> count
    eventSamples      : {},     // eventName -> last sample payload
    incomingResponses : {},     // callName -> count
    responseSamples   : {},     // callName -> last response payload

    // Diagnostics - Outgoing
    lastOutgoing      : [],     // rolling last 50 outgoing messages
    outgoingTypes     : {},     // type -> count
    callNames         : {},     // callName -> count
    callSamples       : {},     // callName -> last args payload
  };

  const S = window.__2048State;

  const TILE_MAP = {
    // Will be populated with custom tile mapping (e.g., 'violet-lion-fizz': 2)
  };

  function rebuildBoard() {
    const board = new Array(16).fill(0);
    let ok = false;
    for (const t of Object.values(S.tiles)) {
      const x = t.x ?? t.col ?? t.column;
      const y = t.y ?? t.row;
      if (x >= 0 && x < 4 && y >= 0 && y < 4) {
        let val = t.value;
        if (typeof val === 'string') {
          const parsed = parseInt(val, 10);
          if (!isNaN(parsed) && parsed > 0) {
            val = parsed;
          } else if (TILE_MAP[val]) {
            val = TILE_MAP[val];
          } else {
            console.warn(`[2048-TileDetector] ⚠️ Unmapped string tile value: "${val}". Falling back to 2.`);
            val = 2;
          }
        }
        if (val > 0) {
          board[y * 4 + x] = val;
          ok = true;
        }
      }
    }
    if (ok) {
      S.board      = board;
      S.lastUpdate = Date.now();
    }
  }

  function getXY(pos) {
    if (!pos) return null;
    const x = pos.x ?? pos.col ?? pos.column ?? pos[0];
    const y = pos.y ?? pos.row           ?? pos[1];
    return (x != null && y != null) ? { x, y } : null;
  }

  function parseTile(t) {
    if (!t || typeof t !== 'object') return null;
    const id  = t.id   ?? t.tileId ?? t.name ?? null;
    let val = t.value ?? t.val   ?? t.v    ?? 0;

    if (typeof val === 'string') {
      console.log(`[2048-TileDetector] 🕵️ Custom string value detected! val="${val}", id="${id}", full tile object:`, JSON.stringify(t));
      const numericKeys = ['level', 'power', 'val', 'v', 'num', 'numericValue', 'scoreValue'];
      for (const k of numericKeys) {
        if (typeof t[k] === 'number') {
          console.log(`[2048-TileDetector] 💡 Found numeric fallback in property "${k}":`, t[k]);
          val = t[k];
          break;
        }
      }
    }

    const xy  = getXY(t.position ?? t.pos ?? t.cell ?? t);
    if (!xy || val === undefined || val === null) return null;
    return { id, x: xy.x, y: xy.y, value: val };
  }

  function processEvent(eventName, data) {
    if (!data) return;

    if (typeof data === 'object') {
      for (const key of ['score', 'points', 'currentScore']) {
        if (typeof data[key] === 'number') { S.score = data[key]; break; }
      }
    }

    if (data && Array.isArray(data.board)) {
      const board = new Array(16).fill(0);
      let ok = false;
      S.tiles = {};
      for (let y = 0; y < data.board.length; y++) {
        const row = data.board[y];
        if (Array.isArray(row)) {
          for (let x = 0; x < row.length; x++) {
            const cell = row[x];
            if (cell && typeof cell === 'object') {
              const p = parseTile(cell);
              if (p) {
                const key = p.id ?? `${p.x},${p.y}`;
                S.tiles[key] = p;
                if (p.x >= 0 && p.x < 4 && p.y >= 0 && p.y < 4 && p.value > 0) {
                  board[p.y * 4 + p.x] = p.value;
                  ok = true;
                }
              }
            }
          }
        }
      }
      if (ok) {
        S.board      = board;
        S.lastUpdate = Date.now();
        return;
      }
    }

    if (data && Array.isArray(data.tiles) && data.tiles.length > 0) {
      const first = data.tiles[0];
      if (first && (first.position || first.pos || first.cell || first.x != null)) {
        S.tiles = {};
        for (const t of data.tiles) {
          const p = parseTile(t);
          if (p) {
            const key = p.id ?? `${p.x},${p.y}`;
            S.tiles[key] = p;
          }
        }
        rebuildBoard();
        return;
      }
    }

    if (data && Array.isArray(data.cells)) {
      const board = [];
      for (const row of data.cells) {
        if (!Array.isArray(row)) { board.length = 0; break; }
        for (const cell of row) {
          board.push(cell ? (cell.value ?? cell.v ?? cell) : 0);
        }
      }
      if (board.length === 16 && board.some(v => v > 0)) {
        S.board      = board;
        S.lastUpdate = Date.now();
        return;
      }
    }

    if (typeof data !== 'object') return;

    let changed = false;

    if (Array.isArray(data.moves)) {
      for (const m of data.moves) {
        const toXY = getXY(m.to ?? m.destination ?? m.target);
        const id   = m.tileId ?? m.id ?? m.tile;
        if (id && toXY && S.tiles[id]) {
          S.tiles[id].x = toXY.x;
          S.tiles[id].y = toXY.y;
          changed = true;
        }
      }
    }

    if (Array.isArray(data.merges ?? data.mergedTiles)) {
      for (const mg of (data.merges ?? data.mergedTiles)) {
        const fromId   = mg.fromId   ?? mg.from?.id  ?? mg.a;
        const toId     = mg.toId     ?? mg.into?.id  ?? mg.b;
        const resultId = mg.resultId ?? mg.result?.id;
        const newVal   = mg.value    ?? mg.resultValue;
        if (fromId) delete S.tiles[fromId];
        const target = resultId ? S.tiles[resultId] : (toId ? S.tiles[toId] : null);
        if (target && newVal) { target.value = newVal; changed = true; }
      }
    }

    for (const spawnKey of ['newTile', 'spawned', 'addedTile', 'tile']) {
      const spawn = data[spawnKey];
      if (spawn && typeof spawn === 'object' && spawn.value) {
        const p = parseTile(spawn);
        if (p) {
          const key = p.id ?? `${p.x},${p.y}`;
          S.tiles[key] = p;
          changed = true;
        }
        break;
      }
    }

    if (!changed && Array.isArray(data) && data.length > 0 && data.length <= 32) {
      for (const item of data) {
        const p = parseTile(item);
        if (p) {
          const key = p.id ?? `${p.x},${p.y}`;
          S.tiles[key] = p;
          changed = true;
        }
      }
    }

    if (changed) rebuildBoard();
  }

  function processIncomingMessage(raw) {
    S.msgCount++;
    S.incomingCount++;
    S.lastIncoming.push(raw);
    if (S.lastIncoming.length > 50) S.lastIncoming.shift();

    if (!raw || typeof raw !== 'object') return;

    const type = raw.type || 'unknown';
    S.incomingTypes[type] = (S.incomingTypes[type] || 0) + 1;

    if ((type === 'event' || type === 'emit') && (raw.event || raw.name)) {
      const eventName = raw.event || raw.name;
      S.eventNames[eventName] = (S.eventNames[eventName] || 0) + 1;
      const data = raw.data !== undefined ? raw.data : (raw.args !== undefined ? raw.args : raw.arguments);
      try {
        S.eventSamples[eventName] = JSON.parse(JSON.stringify(data));
      } catch (_) {
        S.eventSamples[eventName] = data;
      }
      processEvent(eventName, data);
    } else if (type === 'response' && raw.call) {
      const callName = raw.call;
      S.incomingResponses[callName] = (S.incomingResponses[callName] || 0) + 1;
      if (raw.response !== undefined) {
        try {
          S.responseSamples[callName] = JSON.parse(JSON.stringify(raw.response));
        } catch (_) {
          S.responseSamples[callName] = raw.response;
        }
        processEvent('__response__' + callName, raw.response);
      }
    }
  }

  function processOutgoingMessage(raw) {
    S.outgoingCount++;
    S.lastOutgoing.push(raw);
    if (S.lastOutgoing.length > 50) S.lastOutgoing.shift();

    if (!raw || typeof raw !== 'object') return;

    const type = raw.type || 'unknown';
    S.outgoingTypes[type] = (S.outgoingTypes[type] || 0) + 1;

    if (type === 'call' && raw.call) {
      const callName = raw.call;
      S.callNames[callName] = (S.callNames[callName] || 0) + 1;
      if (raw.args !== undefined) {
        try {
          S.callSamples[callName] = JSON.parse(JSON.stringify(raw.args));
        } catch (_) {
          S.callSamples[callName] = raw.args;
        }
        if (callName === 'update' && Array.isArray(raw.args)) {
          processEvent('__outgoing_update__', raw.args[0]);
        }
      }
    }
  }

  const OriginalWorker = window.Worker;

  class InterceptedWorker extends OriginalWorker {
    constructor(scriptURL, options) {
      super(scriptURL, options);
      const name = String(scriptURL).split('/').pop();
      console.log(`[2048-Interceptor] 🔌 Hooked worker: ${name}`);

      super.addEventListener('message', (evt) => {
        try { processIncomingMessage(evt.data); } catch (_) {}
      });
    }

    postMessage(...args) {
      try { processOutgoingMessage(args[0]); } catch (_) {}
      super.postMessage(...args);
    }
  }

  window.Worker = InterceptedWorker;

  console.log('[2048-Interceptor] ✅ Worker patched with full bi-directional tracking.');
})();

// ──────────────────────────────────────────────────────────────────────
//  PART 2: SOLVER
// ──────────────────────────────────────────────────────────────────────
(function () {
  if (window.__2048SolverRunning) {
    console.warn('♻️  [2048] Stopping old solver instance...');
    if (window.__2048SolverStop) window.__2048SolverStop();
  }
  window.__2048SolverRunning = true;

  // ── Config ─────────────────────────────────────────────────────────────
  const CFG = {
    MOVE_INTERVAL_MS  : 250,   // slightly faster now depth is reliable
    BASE_DEPTH        : 6,     // depth 6 → research-brief 80k+ tier
    STARTUP_DELAY_MS  : 2000,
    KEYUP_DELAY_MS    : 50,
    DIAG_INTERVAL     : 25,
    DIAG_VERBOSE      : false,
    MAX_CHANCE_SAMPLES: 6,     // reduced from 8 to keep depth-6 under ~150ms/move
  };

  // ── Key codes ──────────────────────────────────────────────────────────
  const KEY      = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40 };
  const DIRS     = [KEY.UP, KEY.LEFT, KEY.DOWN, KEY.RIGHT];
  const DIR_NAME = { 37: '⬅ LEFT', 38: '⬆ UP', 39: '➡ RIGHT', 40: '⬇ DOWN' };
  const KEY_STR  = { 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown' };

  // ── Send keyboard event ────────────────────────────────────────────────
  function fireKey(type, code) {
    document.dispatchEvent(new KeyboardEvent(type, {
      bubbles: true, cancelable: true,
      key: KEY_STR[code], code: KEY_STR[code],
      keyCode: code, which: code,
    }));
  }
  function sendMove(dir) {
    fireKey('keydown', dir);
    setTimeout(() => fireKey('keyup', dir), CFG.KEYUP_DELAY_MS);
  }

  // ── Score display (DOM) ────────────────────────────────────────────────
  function readScoreDOM() {
    const selectors = [
      '.score-container', '.score', '[class*="score"]',
      '[class*="Score"]', '[data-score]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const v = parseInt(el.textContent.replace(/\D/g, ''), 10);
        if (!isNaN(v)) return v;
      }
    }
    return null;
  }

  // ── Board reading strategies ───────────────────────────────────────────
  function readBoardWorker() {
    const st = window.__2048State;
    if (!st || !st.board) return null;
    if (Date.now() - st.lastUpdate > 10_000) return null;
    const b = st.board;
    if (!Array.isArray(b) || b.length !== 16) return null;
    if (!b.some(v => v > 0)) return null;
    return b;
  }

  function readBoardDOM() {
    const board = [];
    for (let r = 1; r <= 4; r++) {
      for (let c = 1; c <= 4; c++) {
        const pos  = `.tile-position-${c}-${r}`;
        const tile = document.querySelector(`${pos}.tile-merged`) || document.querySelector(pos);
        if (!tile) { board.push(0); continue; }
        const inner = tile.querySelector('.tile-inner') || tile;
        const v = parseInt(inner.textContent, 10);
        board.push(!isNaN(v) && v > 0 ? v : 0);
      }
    }
    return board.some(v => v > 0) ? board : null;
  }

  // ── Strategy C: localStorage (play2048.co guaranteed source) ───────────────
  // play2048.co uses a Svelte persisted store that writes to localStorage["gameState"]
  // after every move. Board format: { board: [[null|{id,value,position:{x,y}},..],..] }
  function readBoardLocalStorage() {
    try {
      const raw = localStorage.getItem('gameState');
      if (!raw) return null;
      const state = JSON.parse(raw);
      const grid = state && (state.board || state.grid);
      if (!Array.isArray(grid) || grid.length === 0) return null;

      const board = new Array(16).fill(0);
      let found = false;
      grid.forEach((row, ri) => {
        if (!Array.isArray(row)) return;
        row.forEach((tile, ci) => {
          if (!tile || typeof tile.value !== 'number' || tile.value <= 0) return;
          const x = (tile.position && typeof tile.position.x === 'number') ? tile.position.x : ci;
          const y = (tile.position && typeof tile.position.y === 'number') ? tile.position.y : ri;
          const idx = y * 4 + x;
          if (idx >= 0 && idx < 16) { board[idx] = tile.value; found = true; }
        });
      });
      return found ? board : null;
    } catch (_) { return null; }
  }

  let boardStrategy = null;
  function readBoard() {
    let board;

    if (boardStrategy === 'worker') {
      board = readBoardWorker();
      if (board) return { board, strategy: 'worker' };
      boardStrategy = null;
    }
    if (boardStrategy === 'localStorage') {
      board = readBoardLocalStorage();
      if (board) return { board, strategy: 'localStorage' };
      boardStrategy = null;
    }
    if (boardStrategy === 'dom') {
      board = readBoardDOM();
      if (board) return { board, strategy: 'dom' };
      boardStrategy = null;
    }

    // Probe all strategies in priority order
    board = readBoardWorker();
    if (board) { boardStrategy = 'worker';       return { board, strategy: 'worker' }; }
    board = readBoardLocalStorage();
    if (board) { boardStrategy = 'localStorage'; return { board, strategy: 'localStorage' }; }
    board = readBoardDOM();
    if (board) { boardStrategy = 'dom';          return { board, strategy: 'dom' }; }

    return { board: null, strategy: 'cycle' };
  }

  // ── Board encoding ─────────────────────────────────────────────────────
  const ENC = { 0:0,2:1,4:2,8:3,16:4,32:5,64:6,128:7,256:8,512:9,
                1024:10,2048:11,4096:12,8192:13,16384:14,32768:15 };
  const DEC = [0,2,4,8,16,32,64,128,256,512,1024,2048,4096,8192,16384,32768];

  function encodeBoard(raw) {
    return raw.map(v => ENC[v] ?? ENC[Math.pow(2, Math.round(Math.log2(v || 1)))] ?? 0);
  }

  // ── Line transform lookup ──────────────────────────────────────────────
  const LINE_CACHE = new Map();

  function buildCache() {
    console.log('%c📐 [2048] Building move cache...', 'color:#818cf8');
    for (let i = 0; i < 0x10000; i++) {
      const a=(i>>12)&0xF, b=(i>>8)&0xF, c=(i>>4)&0xF, d=i&0xF;
      const line = [a,b,c,d];
      mergeLeft(line);
      if (line[0]!==a||line[1]!==b||line[2]!==c||line[3]!==d) LINE_CACHE.set(i,line);
    }
    console.log(`%c📐 [2048] Cache ready (${LINE_CACHE.size} entries)`, 'color:#818cf8');
  }

  function mergeLeft(line) {
    const merged = [false,false,false,false];
    for (let i=1;i<4;i++) {
      let pos=i;
      while (line[pos]!==0 && pos>0) {
        if (line[pos-1]===0) { line[pos-1]=line[pos]; line[pos]=0; pos--; continue; }
        if (!merged[pos-1] && line[pos-1]===line[pos]) { line[pos-1]++; line[pos]=0; merged[pos-1]=true; }
        break;
      }
    }
  }

  const ORDER = {
    [KEY.LEFT]:  [[0,1,2,3],[4,5,6,7],[8,9,10,11],[12,13,14,15]],
    [KEY.RIGHT]: [[3,2,1,0],[7,6,5,4],[11,10,9,8],[15,14,13,12]],
    [KEY.UP]:    [[0,4,8,12],[1,5,9,13],[2,6,10,14],[3,7,11,15]],
    [KEY.DOWN]:  [[12,8,4,0],[13,9,5,1],[14,10,6,2],[15,11,7,3]],
  };

  function applyMove(board, dir) {
    const b = board.slice(); let changed = false;
    for (const [i0,i1,i2,i3] of ORDER[dir]) {
      const key = (b[i0]<<12)|(b[i1]<<8)|(b[i2]<<4)|b[i3];
      const res = LINE_CACHE.get(key);
      if (res) { b[i0]=res[0];b[i1]=res[1];b[i2]=res[2];b[i3]=res[3]; changed=true; }
    }
    return { board:b, changed };
  }

  // ── Snake weight matrices — all 8 symmetries ─────────────────────────────
  // All 8 = 4 corners × 2 orientations (horizontal-snake / vertical-snake).
  // Taking MAX over all 8 prevents the solver from being stuck in one corner.
  const SNAKE_WEIGHTS = [
    [15,14,13,12,  8, 9,10,11,  7, 6, 5, 4,  0, 1, 2, 3], // TL horizontal
    [12,13,14,15, 11,10, 9, 8,  4, 5, 6, 7,  3, 2, 1, 0], // TR horizontal
    [ 0, 1, 2, 3,  7, 6, 5, 4,  8, 9,10,11, 15,14,13,12], // BL horizontal
    [ 3, 2, 1, 0,  4, 5, 6, 7, 11,10, 9, 8, 12,13,14,15], // BR horizontal
    [15, 8, 7, 0, 14, 9, 6, 1, 13,10, 5, 2, 12,11, 4, 3], // TL vertical
    [ 0, 7, 8,15,  1, 6, 9,14,  2, 5,10,13,  3, 4,11,12], // TR vertical
    [12,11, 4, 3, 13,10, 5, 2, 14, 9, 6, 1, 15, 8, 7, 0], // BL vertical
    [ 3, 4,11,12,  2, 5,10,13,  1, 6, 9,14,  0, 7, 8,15], // BR vertical
  ];

  /** Max snake score across all 8 symmetries.
   *  CRITICAL: Uses DEC[board[i]] (actual tile value) NOT encoded log2 value.
   *  Reason: with encoded values, merging two 1024s (enc 10) into 2048 (enc 11)
   *  scores 11×w < 10×w1 + 10×w2 for many positions — the solver would REFUSE merges!
   *  With actual values: 2048×w > 1024×w1 + 1024×w2 always when w > w1+w2 approximately,
   *  making high-value merges correctly beneficial. Weight 0.008 keeps same absolute
   *  scale: 2048×15×0.008 ≈ 246 pts (same as old 11×15×1.5 = 247). */
  function snakeScore(board) {
    let best = -Infinity;
    for (const w of SNAKE_WEIGHTS) {
      let s = 0;
      for (let i = 0; i < 16; i++) s += DEC[board[i]] * w[i];  // actual tile value!
      if (s > best) best = s;
    }
    return best;
  }

  /** Empty cell count — #1 survival metric. Raw count, weight 27. */
  function emptyCount(board) {
    let n = 0;
    for (let i = 0; i < 16; i++) if (board[i] === 0) n++;
    return n;
  }

  /** Monotonicity in log2 space — penalise non-monotonic rows/cols. */
  function monotonicity(board) {
    let penalty = 0;
    for (let r = 0; r < 4; r++) {
      let inc = 0, dec = 0;
      for (let c = 0; c < 3; c++) {
        const a = board[r*4+c], b = board[r*4+c+1];
        if (a > b) dec += a - b; else inc += b - a;
      }
      penalty -= Math.min(inc, dec);
    }
    for (let c = 0; c < 4; c++) {
      let inc = 0, dec = 0;
      for (let r = 0; r < 3; r++) {
        const a = board[r*4+c], b = board[(r+1)*4+c];
        if (a > b) dec += a - b; else inc += b - a;
      }
      penalty -= Math.min(inc, dec);
    }
    return penalty;
  }

  /** Smoothness — penalise large jumps between adjacent tiles (log2 space). */
  function smoothness(board) {
    let s = 0;
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 3; c++)
        if (board[r*4+c] && board[r*4+c+1])
          s -= Math.abs(board[r*4+c] - board[r*4+c+1]);
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 4; c++)
        if (board[r*4+c] && board[(r+1)*4+c])
          s -= Math.abs(board[r*4+c] - board[(r+1)*4+c]);
    return s;
  }

  /** Merge potential — adjacent equal tiles = free future merges. */
  function mergePotential(board) {
    let m = 0;
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 3; c++)
        if (board[r*4+c] && board[r*4+c] === board[r*4+c+1]) m += board[r*4+c];
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 4; c++)
        if (board[r*4+c] && board[r*4+c] === board[(r+1)*4+c]) m += board[r*4+c];
    return m;
  }

  /** Corner bonus — max tile in ANY of the 4 corners.
   *  Multiplier 12 (up from 6) makes corner positioning strongly preferred
   *  over saving 1-2 empty cells. This was the key bug: 2048 landed off-corner. */
  function cornerBonus(board) {
    const max = Math.max(...board);
    if (!max) return 0;
    return (board[0]===max||board[3]===max||board[12]===max||board[15]===max) ? max*12 : 0;
  }

  /** Adjacency bonus — 2nd-largest tile adjacent to largest = merge setup.
   *  Near multiplier raised 4→6: being adjacent to the max is much more valuable. */
  function adjacencyBonus(board) {
    let max = 0, second = 0;
    for (let i = 0; i < 16; i++) {
      if (board[i] > max)         { second = max; max = board[i]; }
      else if (board[i] > second) { second = board[i]; }
    }
    if (!second) return 0;
    let maxIdx = -1, secIdx = -1;
    for (let i = 0; i < 16; i++) {
      if (board[i] === max    && maxIdx < 0) maxIdx = i;
      else if (board[i] === second && secIdx < 0) secIdx  = i;
    }
    const dist = Math.abs((maxIdx>>2)-(secIdx>>2)) + Math.abs((maxIdx&3)-(secIdx&3));
    if (dist === 1) return second * 6;   // adjacent — raised from 4
    if (dist === 2) return second * 2;   // nearby  — raised from 1
    return 0;
  }

  /** Returns true when no valid move exists (game over). */
  function isTerminal(board) {
    for (const dir of DIRS) if (applyMove(board, dir).changed) return false;
    return true;
  }

  /** Full 7-component evaluation — tuned for 80k-100k target. */
  function heuristic(board) {
    if (isTerminal(board)) return -1e9;
    return (
      snakeScore(board)     * 0.008 +  // uses actual tile values; 2048×15×0.008≈246pts
      emptyCount(board)     * 30    +  // most important survival metric
      monotonicity(board)   * 1.5   +
      smoothness(board)     * 0.4   +
      mergePotential(board) * 3.0   +  // encoded values fine here (setup detection)
      cornerBonus(board)            +  // self-weighted × 12
      adjacencyBonus(board)            // self-weighted × 6
    );
  }

  // ── Adaptive depth ──────────────────────────────────────────────────────────
  function adaptDepth(board, base) {
    const e = emptyCount(board);
    if (e <= 2)  return base + 2;
    if (e <= 4)  return base + 1;
    if (e >= 12) return Math.max(3, base - 1);
    return base;
  }

  // ── Adjacency-weighted chance node sampler ──────────────────────────────────
  function sampleCells(board, maxN) {
    const empties = [];
    for (let i = 0; i < 16; i++) {
      if (board[i] !== 0) continue;
      const r = i >> 2, c = i & 3;
      let adj = 0;
      if (r > 0 && board[i-4] > adj) adj = board[i-4];
      if (r < 3 && board[i+4] > adj) adj = board[i+4];
      if (c > 0 && board[i-1] > adj) adj = board[i-1];
      if (c < 3 && board[i+1] > adj) adj = board[i+1];
      empties.push({ i, adj });
    }
    if (empties.length <= maxN) return empties.map(e => e.i);
    empties.sort((a, b) => b.adj - a.adj);
    return empties.slice(0, maxN).map(e => e.i);
  }

  // ── Transposition table ─────────────────────────────────────────────────────
  let TRANS_TABLE = new Map();

  // ── Expectimax ──────────────────────────────────────────────────────────────
  function expectimax(board, depth, isMax) {
    if (depth === 0) {
      const key = board.join('|');
      let v = TRANS_TABLE.get(key);
      if (v === undefined) { v = heuristic(board); TRANS_TABLE.set(key, v); }
      return v;
    }
    if (isMax) {
      let best = -Infinity;
      for (const dir of DIRS) {
        const { board: nb, changed } = applyMove(board, dir);
        if (!changed) continue;
        const s = expectimax(nb, depth - 1, false);
        if (s > best) best = s;
      }
      return best === -Infinity ? heuristic(board) : best;
    } else {
      const cells = sampleCells(board, CFG.MAX_CHANCE_SAMPLES);
      if (!cells.length) return heuristic(board);
      let total = 0;
      for (const idx of cells) {
        const b2 = board.slice(); b2[idx] = 1;
        total += 0.9 * expectimax(b2, depth - 1, true);
        const b4 = board.slice(); b4[idx] = 2;
        total += 0.1 * expectimax(b4, depth - 1, true);
      }
      return total / cells.length;
    }
  }

  function pickBestMove(board) {
    const depth = adaptDepth(board, CFG.BASE_DEPTH);
    TRANS_TABLE = new Map();   // fresh cache per decision

    let bestDir = -1, bestScore = -Infinity;
    const scores = {};
    // Move ordering: Up→Left→Down→Right (finds good candidates early)
    for (const dir of DIRS) {
      const { board: nb, changed } = applyMove(board, dir);
      if (!changed) { scores[DIR_NAME[dir]] = '⛔ blocked'; continue; }
      const s = expectimax(nb, depth - 1, false);
      scores[DIR_NAME[dir]] = Math.round(s).toLocaleString();
      if (s > bestScore) { bestScore = s; bestDir = dir; }
    }
    if (bestDir === -1) {
      for (const dir of DIRS) if (applyMove(board, dir).changed) { bestDir = dir; break; }
    }
    if (bestDir === -1) bestDir = KEY.DOWN;
    return { dir: bestDir, score: bestScore, scores, depth };
  }

  // ── Cycle fallback ─────────────────────────────────────────────────────
  const CYCLE_SEQ = [KEY.DOWN,KEY.LEFT,KEY.DOWN,KEY.LEFT,KEY.DOWN,KEY.LEFT,KEY.UP,KEY.RIGHT];
  let cycleIdx=0;
  function nextCycleMove() { return CYCLE_SEQ[cycleIdx++%CYCLE_SEQ.length]; }

  // ── Pretty board ───────────────────────────────────────────────────────
  function renderBoard(board) {
    let out='';
    for (let r=0;r<4;r++) {
      const row=[];
      for (let c=0;c<4;c++) {
        const v=DEC[board[r*4+c]]||0;
        row.push(String(v===0?'·':v).padStart(5));
      }
      out+='  '+row.join(' ')+'\n';
    }
    return out;
  }

  // ── Diagnostic dump ────────────────────────────────────────────────────
  function printDiagnostics() {
    const st = window.__2048State;
    if (!st) {
      console.warn('%c[2048] ⚠️  window.__2048State is undefined — interceptor.js may not have loaded', 'color:#f87171');
      return;
    }
    console.group('%c[2048] 🔬 INTERCEPTOR DIAGNOSTICS', 'color:#c084fc; font-weight:bold');
    console.log('Incoming messages:', st.incomingCount);
    console.log('Outgoing messages:', st.outgoingCount);
    console.log('Board captured:', st.board ? '✅ YES' : '❌ NO');
    if (st.board) {
      console.log('Current board values:', JSON.stringify(st.board));
    }
    console.log('Score captured:', st.score);
    console.log('Last update ago:', st.lastUpdate ? `${Date.now()-st.lastUpdate}ms` : 'never');
    
    if (CFG.DIAG_VERBOSE) {
      console.log('Incoming Types:', JSON.stringify(st.incomingTypes));
      console.log('Event Names:', JSON.stringify(st.eventNames));
      console.log('Event Samples:', JSON.stringify(st.eventSamples));
      console.log('Response Samples:', JSON.stringify(st.responseSamples));
      
      console.log('Outgoing Types:', JSON.stringify(st.outgoingTypes));
      console.log('Call Names:', JSON.stringify(st.callNames));
      console.log('Call Samples:', JSON.stringify(st.callSamples));

      if (st.lastIncoming && st.lastIncoming.length > 0) {
        console.groupCollapsed('Last 5 Incoming Messages (Worker -> Main)');
        st.lastIncoming.slice(-5).forEach((m, i) => {
          try {
            console.log(`  [Incoming -${5-i}]`, JSON.stringify(m));
          } catch (_) {
            console.log(`  [Incoming -${5-i}]`, m);
          }
        });
        console.groupEnd();
      }
      if (st.lastOutgoing && st.lastOutgoing.length > 0) {
        console.groupCollapsed('Last 5 Outgoing Messages (Main -> Worker)');
        st.lastOutgoing.slice(-5).forEach((m, i) => {
          try {
            console.log(`  [Outgoing -${5-i}]`, JSON.stringify(m));
          } catch (_) {
            console.log(`  [Outgoing -${5-i}]`, m);
          }
        });
        console.groupEnd();
      }
    }
    console.groupEnd();
  }

  // ── Main loop ──────────────────────────────────────────────────────────
  let moveInterval = null;
  let moveCount    = 0;
  let stuckCount   = 0;
  let lastEncBoard = null;

  function tick() {
    moveCount++;
    const { board: rawBoard, strategy } = readBoard();
    const useAI = rawBoard !== null;

    let dir, scoreInfo;

    if (useAI) {
      const board  = encodeBoard(rawBoard);
      const empty  = board.filter(v=>v===0).length;
      const maxTile = DEC[Math.max(...board)];

      if (lastEncBoard && board.every((v,i)=>v===lastEncBoard[i])) {
        stuckCount++;
        if (stuckCount>=3) {
          console.warn(`%c🔄 [2048] Stuck ${stuckCount} ticks — forcing UP`, 'color:#f87171');
          dir = KEY.UP;
        }
      } else {
        stuckCount = 0;
      }
      lastEncBoard = board.slice();

      let depthUsed = CFG.EXPECTIMAX_DEPTH;
      if (!dir) {
        const res = pickBestMove(board);
        dir       = res.dir;
        scoreInfo = res.scores;
        depthUsed = res.depth;
      }

      const domScore = readScoreDOM();
      const st = window.__2048State;

      console.groupCollapsed(
        `%c[2048] #${moveCount}  ${DIR_NAME[dir].padEnd(10)}  🏆 ${String(maxTile).padStart(5)}  🟩 ${empty}/16  📡 ${strategy}`,
        'color:#4ade80; font-weight:bold; font-family:monospace'
      );
      console.log('%cBoard state:\n' + renderBoard(board), 'color:#94a3b8; font-family:monospace');
      if (scoreInfo) {
        console.log('%cExpectimax scores per direction:', 'color:#94a3b8');
        console.table(scoreInfo);
      }
      console.log(
        `%cScore: ${domScore ?? st?.score ?? '?'}  |  Interval: ${CFG.MOVE_INTERVAL_MS}ms  |  Depth: ${depthUsed}`,
        'color:#64748b'
      );
      console.groupEnd();

      if (moveCount % CFG.DIAG_INTERVAL === 0) printDiagnostics();

    } else {
      dir = nextCycleMove();
      if (moveCount % 5 === 0) {
        console.log(
          `%c[2048] #${moveCount}  ${DIR_NAME[dir]}  🔁 Cycle (worker not yet readable)`,
          'color:#f59e0b; font-family:monospace'
        );
      }
      if (moveCount % 5 === 0) printDiagnostics();
    }

    sendMove(dir);
  }

  // ── Start / Stop ───────────────────────────────────────────────────────
  function startSolver() {
    if (moveInterval) { console.warn('⚠️  [2048] Already running.'); return; }
    console.log(`%c⏳ [2048] Waiting ${CFG.STARTUP_DELAY_MS}ms for game + interceptor to boot...`, 'color:#818cf8');

    setTimeout(() => {
      buildCache();

      const { board: testBoard, strategy } = readBoard();

      console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color:#475569');
      console.log('%c🎮  2048 SOLVER  —  STARTED', 'color:#f59e0b; font-size:16px; font-weight:bold');
      console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color:#475569');

      if (testBoard) {
        console.log(`   Mode:      🧠 Expectimax AI  (source: ${strategy})`);
      } else {
        console.log('   Mode:      🔁 Cycle fallback');
        console.log('   Reason:    Worker messages not yet captured.');
        console.log('   ➡ If this persists, reload the page (do not just reload extension).');
      }

      console.log(`   Algorithm: Expectimax depth-${CFG.BASE_DEPTH} (adaptive: +1 at ≤4 empty, +2 at ≤2 empty)`);
      console.log('   Heuristics: snake(8-sym)×1.2 + empty×27 + mono×1.5 + smooth×0.4 + merge×2.5 + corner + adjacency');
      console.log(`   Sampling:  adjacency-weighted chance nodes (max ${CFG.MAX_CHANCE_SAMPLES} cells)`);
      console.log(`   Interval:  ${CFG.MOVE_INTERVAL_MS}ms`);
      console.log(`   Controls:  window.__2048SolverStop()  |  window.__2048SolverStart()`);
      console.log(`   Diagnose:  window.__2048Status()  ← run this any time to check board reading`);
      console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color:#475569');

      printDiagnostics();

      moveInterval = setInterval(tick, CFG.MOVE_INTERVAL_MS);
    }, CFG.STARTUP_DELAY_MS);
  }

  function stopSolver() {
    if (moveInterval) { clearInterval(moveInterval); moveInterval=null; }
    window.__2048SolverRunning = false;
    console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color:#475569');
    console.log('%c🛑  2048 SOLVER  —  STOPPED', 'color:#f87171; font-size:16px; font-weight:bold');
    console.log(`%c   Total moves: ${moveCount}`, 'color:#94a3b8');
    console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color:#475569');
  }

  window.__2048SolverStop  = stopSolver;
  window.__2048SolverStart = startSolver;

  /** Run window.__2048Status() in the browser console to instantly diagnose board reading. */
  window.__2048Status = function() {
    console.group('%c[2048] 🩺 STATUS', 'color:#38bdf8; font-weight:bold');
    console.log('Move count:   ', moveCount);
    console.log('Current mode: ', boardStrategy ?? 'not started');

    const ls = readBoardLocalStorage();
    console.log('localStorage board:', ls ? ls.join(',') : '❌ null — gameState not yet saved (make 1 manual move)');

    const wk = readBoardWorker();
    console.log('Worker board:     ', wk ? wk.join(',') : '❌ null');

    const dom = readBoardDOM();
    console.log('DOM board:        ', dom ? dom.join(',') : '❌ null');

    const st = window.__2048State;
    console.log('Worker messages:  ', st ? `in=${st.incomingCount} out=${st.outgoingCount}` : '❌ interceptor not running');
    if (st) {
      console.log('Event types seen: ', JSON.stringify(st.eventNames));
      console.log('Last 3 messages:  ', st.lastIncoming.slice(-3));
    }
    console.groupEnd();
  };

  window.addEventListener('message', e => {
    if (!e.data?.__2048Solver) return;
    if (e.data.action==='stop')  stopSolver();
    if (e.data.action==='start') startSolver();
  });

  console.log('%c🚀 [2048] solver v3.0 loaded — run window.__2048Status() to check board reading', 'color:#818cf8; font-weight:bold');
  startSolver();
})();