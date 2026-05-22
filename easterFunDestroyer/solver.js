'use strict';

// ══════════════════════════════════════════════════════════════════════════════
//  2048 Auto-Solver  —  PAGE WORLD  v3.0  (Research-Brief Implementation)
//
//  Algorithm: Expectimax, depth 5-7 adaptive
//  Heuristic: 7 components —
//    1. Snake score        (all 8 symmetries — critical for no corner-lock)
//    2. Empty cell count   (weight 27 — the #1 survival metric)
//    3. Monotonicity       (log2-domain — penalise value jumps)
//    4. Smoothness         (log2-domain — reward similar neighbours)
//    5. Merge potential    (log2-weighted adjacent pairs)
//    6. Corner bonus       (max tile in ANY of the 4 corners)
//    7. Adjacency bonus    (2nd-largest adjacent to largest)
//
//  Speed: precomputed 65k row-move table + transposition table + Web Worker
//  Target: consistent 4096 tiles, avg score 80k+
// ══════════════════════════════════════════════════════════════════════════════

if (window.__2048SolverRunning) {
  console.warn('♻️  [2048] Stopping old solver instance...');
  if (window.__2048SolverStop) window.__2048SolverStop();
}
window.__2048SolverRunning = true;

// ── Config ────────────────────────────────────────────────────────────────────
const CFG = {
  MOVE_INTERVAL_MS : 300,
  BASE_DEPTH       : 5,    // research-brief minimum; adaptive escalation adds 1-2
  STARTUP_DELAY_MS : 2000,
  KEYUP_DELAY_MS   : 60,
  DIAG_INTERVAL    : 25,
  MAX_CHANCE_SAMPLES: 8,   // adjacency-ranked cell sample limit for chance nodes
};

// Heuristic weights  (from research brief §10, proven at 60k+)
const W = {
  snake       : 1.2,
  empty       : 27,
  monotonicity: 1.5,
  smoothness  : 0.4,
  merge       : 2.5,
  // cornerBonus and adjacencyBonus are self-weighted inside their functions
};

// ── Key codes ─────────────────────────────────────────────────────────────────
const KEY      = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40 };
// Move ordering from research brief §5: Up, Left, Down, Right finds good moves early
const DIRS     = [KEY.UP, KEY.LEFT, KEY.DOWN, KEY.RIGHT];
const DIR_NAME = { 37: '⬅ LEFT', 38: '⬆ UP', 39: '➡ RIGHT', 40: '⬇ DOWN' };
const KEY_STR  = { 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown' };

// ── Input dispatch ────────────────────────────────────────────────────────────
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

// ── Score display ─────────────────────────────────────────────────────────────
function readScoreDOM() {
  const selectors = ['.score-container', '.score', '[class*="score"]', '[class*="Score"]', '[data-score]'];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      const v = parseInt(el.textContent.replace(/\D/g, ''), 10);
      if (!isNaN(v)) return v;
    }
  }
  return null;
}

// ── Board reading ─────────────────────────────────────────────────────────────
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
  board = readBoardWorker();
  if (board) { boardStrategy = 'worker'; return { board, strategy: 'worker' }; }
  board = readBoardLocalStorage();
  if (board) { boardStrategy = 'localStorage'; return { board, strategy: 'localStorage' }; }
  board = readBoardDOM();
  if (board) { boardStrategy = 'dom';    return { board, strategy: 'dom' }; }
  return { board: null, strategy: 'cycle' };
}

// ── Board encoding (log2 representation) ─────────────────────────────────────
// board values: 0→0, 2→1, 4→2, 8→3 ... 32768→15
// This lets us use encoded values directly as log2 in heuristics (huge perf win)
const ENC = { 0:0,2:1,4:2,8:3,16:4,32:5,64:6,128:7,256:8,512:9,
              1024:10,2048:11,4096:12,8192:13,16384:14,32768:15 };
const DEC = [0,2,4,8,16,32,64,128,256,512,1024,2048,4096,8192,16384,32768];

function encodeBoard(raw) {
  return raw.map(v => ENC[v] ?? (v > 0 ? Math.min(15, Math.round(Math.log2(v))) : 0));
}

// ── Precomputed Tables (nneonneo style) ──────────────────────────────────────
const ROW_LEFT_TABLE = new Uint16Array(65536);
const HEUR_SCORE_TABLE = new Float32Array(65536);
const SCORE_TABLE = new Float32Array(65536);

function initTables() {
  const SCORE_LOST_PENALTY = 200000.0;
  const SCORE_MONOTONICITY_POWER = 4.0;
  const SCORE_MONOTONICITY_WEIGHT = 47.0;
  const SCORE_SUM_POWER = 3.5;
  const SCORE_SUM_WEIGHT = 11.0;
  const SCORE_MERGES_WEIGHT = 700.0;
  const SCORE_EMPTY_WEIGHT = 270.0;

  for (let row = 0; row < 65536; ++row) {
    const line = [
      row & 0xf,
      (row >> 4) & 0xf,
      (row >> 8) & 0xf,
      (row >> 12) & 0xf
    ];

    // Score Table
    let score = 0.0;
    for (let i = 0; i < 4; ++i) {
      const rank = line[i];
      if (rank >= 2) {
        score += (rank - 1) * (1 << rank);
      }
    }
    SCORE_TABLE[row] = score;

    // Heuristic Score Table
    let sum = 0;
    let empty = 0;
    let merges = 0;
    let prev = 0;
    let counter = 0;

    for (let i = 0; i < 4; ++i) {
      const rank = line[i];
      sum += Math.pow(rank, SCORE_SUM_POWER);
      if (rank === 0) {
        empty++;
      } else {
        if (prev === rank) {
          counter++;
        } else if (counter > 0) {
          merges += 1 + counter;
          counter = 0;
        }
        prev = rank;
      }
    }
    if (counter > 0) {
      merges += 1 + counter;
    }

    let monotonicity_left = 0;
    let monotonicity_right = 0;
    for (let i = 1; i < 4; ++i) {
      if (line[i-1] > line[i]) {
        monotonicity_left += Math.pow(line[i-1], SCORE_MONOTONICITY_POWER) - Math.pow(line[i], SCORE_MONOTONICITY_POWER);
      } else {
        monotonicity_right += Math.pow(line[i], SCORE_MONOTONICITY_POWER) - Math.pow(line[i-1], SCORE_MONOTONICITY_POWER);
      }
    }

    HEUR_SCORE_TABLE[row] = SCORE_LOST_PENALTY +
      SCORE_EMPTY_WEIGHT * empty +
      SCORE_MERGES_WEIGHT * merges -
      SCORE_MONOTONICITY_WEIGHT * Math.min(monotonicity_left, monotonicity_right) -
      SCORE_SUM_WEIGHT * sum;

    // execute a move to the left
    for (let i = 0; i < 3; ++i) {
      let j;
      for (j = i + 1; j < 4; ++j) {
        if (line[j] !== 0) break;
      }
      if (j === 4) break;

      if (line[i] === 0) {
        line[i] = line[j];
        line[j] = 0;
        i--;
      } else if (line[i] === line[j]) {
        if (line[i] !== 0xf) {
          line[i]++;
        }
        line[j] = 0;
      }
    }

    ROW_LEFT_TABLE[row] = line[0] | (line[1] << 4) | (line[2] << 8) | (line[3] << 12);
  }
}

function scoreHeurBoard(board) {
  return HEUR_SCORE_TABLE[board[0]  | (board[1]  << 4) | (board[2]  << 8) | (board[3]  << 12)] +
         HEUR_SCORE_TABLE[board[4]  | (board[5]  << 4) | (board[6]  << 8) | (board[7]  << 12)] +
         HEUR_SCORE_TABLE[board[8]  | (board[9]  << 4) | (board[10] << 8) | (board[11] << 12)] +
         HEUR_SCORE_TABLE[board[12] | (board[13] << 4) | (board[14] << 8) | (board[15] << 12)] +
         HEUR_SCORE_TABLE[board[0]  | (board[4]  << 4) | (board[8]  << 8) | (board[12] << 12)] +
         HEUR_SCORE_TABLE[board[1]  | (board[5]  << 4) | (board[9]  << 8) | (board[13] << 12)] +
         HEUR_SCORE_TABLE[board[2]  | (board[6]  << 4) | (board[10] << 8) | (board[14] << 12)] +
         HEUR_SCORE_TABLE[board[3]  | (board[7]  << 4) | (board[11] << 8) | (board[15] << 12)];
}

function buildCache() {
  console.log('%c📐 [2048] Initializing nneonneo precomputed tables...', 'color:#818cf8');
  const startTime = performance.now();
  initTables();
  const elapsed = performance.now() - startTime;
  console.log(`%c📐 [2048] Tables ready in ${elapsed.toFixed(2)}ms`, 'color:#818cf8');
}

const ORDER = {
  [KEY.LEFT]:  [[0,1,2,3],[4,5,6,7],[8,9,10,11],[12,13,14,15]],
  [KEY.RIGHT]: [[3,2,1,0],[7,6,5,4],[11,10,9,8],[15,14,13,12]],
  [KEY.UP]:    [[0,4,8,12],[1,5,9,13],[2,6,10,14],[3,7,11,15]],
  [KEY.DOWN]:  [[12,8,4,0],[13,9,5,1],[14,10,6,2],[15,11,7,3]],
};

function applyMove(board, dir) {
  let b = null;
  let changed = false;
  const order = ORDER[dir];
  for (let i = 0; i < 4; i++) {
    const [i0, i1, i2, i3] = order[i];
    const key = board[i0] | (board[i1] << 4) | (board[i2] << 8) | (board[i3] << 12);
    const resVal = ROW_LEFT_TABLE[key];
    const r0 = resVal & 0xf;
    const r1 = (resVal >> 4) & 0xf;
    const r2 = (resVal >> 8) & 0xf;
    const r3 = (resVal >> 12) & 0xf;
    if (r0 !== board[i0] || r1 !== board[i1] || r2 !== board[i2] || r3 !== board[i3]) {
      if (!changed) {
        b = board.slice();
        changed = true;
      }
      b[i0] = r0;
      b[i1] = r1;
      b[i2] = r2;
      b[i3] = r3;
    }
  }
  return { board: changed ? b : board, changed };
}

function countEmpty(board) {
  let empty = 0;
  for (let i = 0; i < 16; i++) {
    if (board[i] === 0) empty++;
  }
  return empty;
}

function countDistinctTiles(board) {
  let bitset = 0;
  for (let i = 0; i < 16; ++i) {
    bitset |= 1 << board[i];
  }
  bitset >>= 1;

  let count = 0;
  while (bitset > 0) {
    bitset &= bitset - 1;
    count++;
  }
  return count;
}

const CPROB_THRESH_BASE = 0.0001;
const CACHE_DEPTH_LIMIT = 15;

function scoreTileChooseNode(state, board, cprob) {
  if (cprob < CPROB_THRESH_BASE || state.curDepth >= state.depthLimit) {
    state.maxDepth = Math.max(state.curDepth, state.maxDepth);
    return scoreHeurBoard(board);
  }

  let key;
  if (state.curDepth < CACHE_DEPTH_LIMIT) {
    key = String.fromCharCode(...board);
    const entry = state.transTable.get(key);
    if (entry !== undefined) {
      if (entry.depth <= state.curDepth) {
        state.cacheHits++;
        return entry.heuristic;
      }
    }
  }

  const numOpen = countEmpty(board);
  const nextCProb = cprob / numOpen;

  let res = 0.0;
  for (let i = 0; i < 16; i++) {
    if (board[i] === 0) {
      board[i] = 1;
      res += scoreMoveNode(state, board, nextCProb * 0.9) * 0.9;
      board[i] = 2;
      res += scoreMoveNode(state, board, nextCProb * 0.1) * 0.1;
      board[i] = 0;
    }
  }
  res = res / numOpen;

  if (state.curDepth < CACHE_DEPTH_LIMIT) {
    state.transTable.set(key, { depth: state.curDepth, heuristic: res });
  }

  return res;
}

function scoreMoveNode(state, board, cprob) {
  let best = 0.0;
  state.curDepth++;
  for (let move = 0; move < 4; ++move) {
    const dir = DIRS[move];
    const { board: newboard, changed } = applyMove(board, dir);
    state.movesEvaled++;

    if (changed) {
      best = Math.max(best, scoreTileChooseNode(state, newboard, cprob));
    }
  }
  state.curDepth--;
  return best;
}

function pickBestMove(board) {
  const depthLimit = Math.max(3, countDistinctTiles(board) - 2);

  const state = {
    transTable: new Map(),
    maxDepth: 0,
    curDepth: 0,
    cacheHits: 0,
    movesEvaled: 0,
    depthLimit: depthLimit
  };

  let bestDir = -1;
  let bestScore = -Infinity;
  const scores = {};

  const startTime = performance.now();

  for (let move = 0; move < 4; move++) {
    const dir = DIRS[move];
    const { board: newboard, changed } = applyMove(board, dir);
    if (!changed) {
      scores[DIR_NAME[dir]] = '⛔ blocked';
      continue;
    }

    const res = scoreTileChooseNode(state, newboard, 1.0) + 1e-6;
    scores[DIR_NAME[dir]] = Math.round(res).toLocaleString();

    if (res > bestScore) {
      bestScore = res;
      bestDir = dir;
    }
  }

  const elapsed = (performance.now() - startTime) / 1000.0;
  console.log(`[2048] AI Move selection: best = ${DIR_NAME[bestDir]}, score = ${bestScore.toFixed(2)}, eval'd ${state.movesEvaled} nodes (${state.cacheHits} cache hits, cache size ${state.transTable.size}) in ${elapsed.toFixed(3)}s (maxdepth=${state.maxDepth})`);

  if (bestDir === -1) {
    for (const dir of DIRS) {
      if (applyMove(board, dir).changed) {
        bestDir = dir;
        break;
      }
    }
  }
  if (bestDir === -1) bestDir = KEY.DOWN;

  return { dir: bestDir, score: bestScore, scores, depth: depthLimit, cacheSize: state.transTable.size };
}

// ── Cycle fallback (when board state unavailable) ─────────────────────────────
const CYCLE_SEQ = [KEY.DOWN,KEY.LEFT,KEY.DOWN,KEY.LEFT,KEY.DOWN,KEY.LEFT,KEY.UP,KEY.RIGHT];
let cycleIdx = 0;
function nextCycleMove() { return CYCLE_SEQ[cycleIdx++ % CYCLE_SEQ.length]; }

// ── Pretty board printer ──────────────────────────────────────────────────────
function renderBoard(board) {
  let out = '';
  for (let r = 0; r < 4; r++) {
    const row = [];
    for (let c = 0; c < 4; c++) {
      const v = DEC[board[r*4+c]] || 0;
      row.push(String(v === 0 ? '·' : v).padStart(6));
    }
    out += '  ' + row.join(' ') + '\n';
  }
  return out;
}

// ── Diagnostics ───────────────────────────────────────────────────────────────
function printDiagnostics() {
  const st = window.__2048State;
  if (!st) {
    console.warn('%c[2048] ⚠️  window.__2048State undefined — interceptor.js may not be loaded', 'color:#f87171');
    return;
  }
  console.group('%c[2048] 🔬 INTERCEPTOR DIAGNOSTICS', 'color:#c084fc; font-weight:bold');
  console.log('Board captured:', st.board ? '✅ YES' : '❌ NO');
  if (st.board) console.log('Board:', st.board);
  console.log('Score:', st.score);
  console.log('Last update:', st.lastUpdate ? `${Date.now()-st.lastUpdate}ms ago` : 'never');
  console.log('Incoming messages:', st.incomingCount);
  console.log('Outgoing messages:', st.outgoingCount);
  if (st.lastIncoming?.length) {
    console.groupCollapsed('Last 5 Incoming (Worker→Main)');
    st.lastIncoming.slice(-5).forEach((m,i) => console.log(`  [-${5-i}]`, m));
    console.groupEnd();
  }
  console.groupEnd();
}

// ── Main loop ─────────────────────────────────────────────────────────────────
let moveInterval = null;
let moveCount    = 0;
let stuckCount   = 0;
let lastEncBoard = null;

function tick() {
  moveCount++;
  const { board: rawBoard, strategy } = readBoard();
  const useAI = rawBoard !== null;

  let dir, scoreInfo, depthUsed, cacheSize = 0;

  if (useAI) {
    const board   = encodeBoard(rawBoard);
    const empty   = countEmpty(board);
    const maxTile = DEC[Math.max(...board)];

    // Stuck detection: board unchanged for 3+ ticks → force unstuck move
    if (lastEncBoard && board.every((v,i) => v === lastEncBoard[i])) {
      stuckCount++;
      if (stuckCount >= 3) {
        console.warn(`%c🔄 [2048] Stuck ${stuckCount} ticks — forcing unstuck move`, 'color:#f87171');
        // Try any valid direction that's not the last used
        for (const d of [KEY.UP, KEY.LEFT, KEY.RIGHT, KEY.DOWN]) {
          if (applyMove(board, d).changed) { dir = d; break; }
        }
      }
    } else {
      stuckCount = 0;
    }
    lastEncBoard = board.slice();

    if (!dir) {
      const res = pickBestMove(board);
      dir       = res.dir;
      scoreInfo = res.scores;
      depthUsed = res.depth;
      cacheSize = res.cacheSize;
    }

    const domScore = readScoreDOM();

    console.groupCollapsed(
      `%c[2048] #${moveCount}  ${DIR_NAME[dir].padEnd(10)}  🏆 ${String(maxTile).padStart(6)}  🟩 ${empty}/16  🔍 d${depthUsed}  📡 ${strategy}`,
      'color:#4ade80; font-weight:bold; font-family:monospace'
    );
    console.log('%cBoard:\n' + renderBoard(board), 'color:#94a3b8; font-family:monospace');
    if (scoreInfo) {
      console.log('%cExpectimax scores:', 'color:#94a3b8');
      console.table(scoreInfo);
    }
    console.log(`%cScore: ${domScore ?? '?'}  |  Interval: ${CFG.MOVE_INTERVAL_MS}ms  |  Depth: ${depthUsed}  |  Cache: ${cacheSize}`, 'color:#64748b');
    console.groupEnd();

    if (moveCount % CFG.DIAG_INTERVAL === 0) printDiagnostics();

  } else {
    // Cycle fallback while board is unreadable
    dir = nextCycleMove();
    if (moveCount % 5 === 0) {
      console.log(`%c[2048] #${moveCount}  ${DIR_NAME[dir]}  🔁 Cycle`, 'color:#f59e0b; font-family:monospace');
      printDiagnostics();
    }
  }

  sendMove(dir);
}

// ── Start / Stop ──────────────────────────────────────────────────────────────
function startSolver() {
  if (moveInterval) { console.warn('⚠️  [2048] Already running.'); return; }
  console.log(`%c⏳ [2048] Booting solver v3.0 in ${CFG.STARTUP_DELAY_MS}ms...`, 'color:#818cf8');

  setTimeout(() => {
    buildCache();

    const { board: testBoard, strategy } = readBoard();

    console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color:#475569');
    console.log('%c🎮  2048 SOLVER v3.0  —  STARTED', 'color:#f59e0b; font-size:16px; font-weight:bold');
    console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color:#475569');
    console.log(`   Algorithm:    Expectimax with dynamic depth (countDistinctTiles - 2)`);
    console.log(`   Heuristics:   Precomputed HEUR_SCORE_TABLE (monotonicity, sum, empty, merges) via 8 lookup operations`);
    console.log(`   Chance nodes: Expectimax with threshold pruning (cprob < 0.0001)`);
    console.log(`   Move table:   65536 row-move entries precomputed`);
    console.log(`   Mode:         ${testBoard ? `🧠 Expectimax AI (source: ${strategy})` : '🔁 Cycle fallback'}`);
    console.log(`   Interval:     ${CFG.MOVE_INTERVAL_MS}ms`);
    console.log(`   Controls:     window.__2048SolverStop()  |  window.__2048SolverStart()`);
    console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color:#475569');

    printDiagnostics();
    moveInterval = setInterval(tick, CFG.MOVE_INTERVAL_MS);
  }, CFG.STARTUP_DELAY_MS);
}

function stopSolver() {
  if (moveInterval) { clearInterval(moveInterval); moveInterval = null; }
  window.__2048SolverRunning = false;
  console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color:#475569');
  console.log('%c🛑  2048 SOLVER v3.0  —  STOPPED', 'color:#f87171; font-size:16px; font-weight:bold');
  console.log(`%c   Total moves: ${moveCount}`, 'color:#94a3b8');
  console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color:#475569');
}

window.__2048SolverStop  = stopSolver;
window.__2048SolverStart = startSolver;
window.addEventListener('message', e => {
  if (!e.data?.__2048Solver) return;
  if (e.data.action === 'stop')  stopSolver();
  if (e.data.action === 'start') startSolver();
});

console.log('%c🚀 [2048] solver.js v3.0 loaded', 'color:#818cf8; font-weight:bold');
startSolver();
