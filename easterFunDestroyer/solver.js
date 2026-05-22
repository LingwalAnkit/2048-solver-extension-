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

let boardStrategy = null;
function readBoard() {
  let board;
  if (boardStrategy === 'worker') {
    board = readBoardWorker();
    if (board) return { board, strategy: 'worker' };
    boardStrategy = null;
  }
  if (boardStrategy === 'dom') {
    board = readBoardDOM();
    if (board) return { board, strategy: 'dom' };
    boardStrategy = null;
  }
  board = readBoardWorker();
  if (board) { boardStrategy = 'worker'; return { board, strategy: 'worker' }; }
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

// ── Precomputed row-move lookup table (65536 entries) ─────────────────────────
// KEY: 16-bit integer (4 nibbles, each = encoded tile 0-15)
// VALUE: new 4-encoded-tile array after merging left
// Result: each applyMove call = 4 table lookups instead of iteration → ~10x faster
const LINE_CACHE = new Map();

function mergeLeft(line) {
  // in-place merge of encoded line leftward
  const merged = [false, false, false, false];
  for (let i = 1; i < 4; i++) {
    let pos = i;
    while (line[pos] !== 0 && pos > 0) {
      if (line[pos-1] === 0) { line[pos-1] = line[pos]; line[pos] = 0; pos--; continue; }
      if (!merged[pos-1] && line[pos-1] === line[pos]) {
        line[pos-1]++;   // merge: value doubles = log2 + 1
        line[pos] = 0;
        merged[pos-1] = true;
      }
      break;
    }
  }
}

function buildCache() {
  console.log('%c📐 [2048] Building 65k row-move cache...', 'color:#818cf8');
  for (let i = 0; i < 0x10000; i++) {
    const a=(i>>12)&0xF, b=(i>>8)&0xF, c=(i>>4)&0xF, d=i&0xF;
    const line = [a,b,c,d];
    mergeLeft(line);
    if (line[0]!==a || line[1]!==b || line[2]!==c || line[3]!==d) LINE_CACHE.set(i, line);
  }
  console.log(`%c📐 [2048] Cache ready (${LINE_CACHE.size} entries)`, 'color:#818cf8');
}

// Index order for each direction: each inner array is [first, second, third, fourth]
// representing the 4 positions traversed in merge direction
const ORDER = {
  [KEY.LEFT]:  [[0,1,2,3],[4,5,6,7],[8,9,10,11],[12,13,14,15]],
  [KEY.RIGHT]: [[3,2,1,0],[7,6,5,4],[11,10,9,8],[15,14,13,12]],
  [KEY.UP]:    [[0,4,8,12],[1,5,9,13],[2,6,10,14],[3,7,11,15]],
  [KEY.DOWN]:  [[12,8,4,0],[13,9,5,1],[14,10,6,2],[15,11,7,3]],
};

function applyMove(board, dir) {
  const b = board.slice();
  let changed = false;
  for (const [i0,i1,i2,i3] of ORDER[dir]) {
    const key = (b[i0]<<12)|(b[i1]<<8)|(b[i2]<<4)|b[i3];
    const res = LINE_CACHE.get(key);
    if (res) { b[i0]=res[0]; b[i1]=res[1]; b[i2]=res[2]; b[i3]=res[3]; changed=true; }
  }
  return { board: b, changed };
}

// ── Snake weight matrices — all 8 symmetries ──────────────────────────────────
// Each matrix is a flat 16-element array of weights (0-15).
// Score = Σ encoded[i] × weight[i].  Higher weight = tiles here matter more.
// All 8 = 4 corners × 2 orientations (horizontal-snake / vertical-snake).
// Taking MAX over all 8 prevents the solver from getting stuck in one corner.
const SNAKE_WEIGHTS = [
  // ── TL horizontal: top-left anchor, snake goes →↓← ─────────────────────────
  [15,14,13,12,  8, 9,10,11,  7, 6, 5, 4,  0, 1, 2, 3],
  // ── TR horizontal: top-right anchor, snake goes ←↓→ ─────────────────────────
  [12,13,14,15, 11,10, 9, 8,  4, 5, 6, 7,  3, 2, 1, 0],
  // ── BL horizontal: bottom-left anchor, snake goes →↑← ───────────────────────
  [ 0, 1, 2, 3,  7, 6, 5, 4,  8, 9,10,11, 15,14,13,12],
  // ── BR horizontal: bottom-right anchor, snake goes ←↑→ ──────────────────────
  [ 3, 2, 1, 0,  4, 5, 6, 7, 11,10, 9, 8, 12,13,14,15],
  // ── TL vertical: top-left anchor, snake goes ↓→↑ ─────────────────────────────
  [15, 8, 7, 0, 14, 9, 6, 1, 13,10, 5, 2, 12,11, 4, 3],
  // ── TR vertical: top-right anchor, snake goes ↓←↑ ────────────────────────────
  [ 0, 7, 8,15,  1, 6, 9,14,  2, 5,10,13,  3, 4,11,12],
  // ── BL vertical: bottom-left anchor, snake goes ↑→↓ ─────────────────────────
  [12,11, 4, 3, 13,10, 5, 2, 14, 9, 6, 1, 15, 8, 7, 0],
  // ── BR vertical: bottom-right anchor, snake goes ↑←↓ ────────────────────────
  [ 3, 4,11,12,  2, 5,10,13,  1, 6, 9,14,  0, 7, 8,15],
];

// ── Heuristic components (all work on encoded/log2 board) ─────────────────────

/** Max snake score across all 8 symmetries. Prevents hard corner-locking. */
function snakeScore(board) {
  let best = -Infinity;
  for (const w of SNAKE_WEIGHTS) {
    let s = 0;
    for (let i = 0; i < 16; i++) s += board[i] * w[i];
    if (s > best) best = s;
  }
  return best;
}

/** Number of empty cells. Single most important survival metric (weight 27). */
function emptyCount(board) {
  let n = 0;
  for (let i = 0; i < 16; i++) if (board[i] === 0) n++;
  return n;
}

/**
 * Monotonicity — penalises rows/cols that are not monotonically ordered.
 * Works in log2 space (encoded values), as per research brief §4.1.C.
 */
function monotonicity(board) {
  let penalty = 0;
  // Rows
  for (let r = 0; r < 4; r++) {
    let inc = 0, dec = 0;
    for (let c = 0; c < 3; c++) {
      const a = board[r*4+c], b = board[r*4+c+1];
      if (a > b) dec += a - b; else inc += b - a;
    }
    penalty -= Math.min(inc, dec);
  }
  // Columns
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

/**
 * Smoothness — penalises large value differences between adjacent tiles.
 * Uses encoded (log2) differences so 2 vs 4 = 1 step, not 2 raw difference.
 */
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

/**
 * Merge potential — reward boards with adjacent equal tiles.
 * These are "free merges" waiting to happen.
 * Uses encoded value as weight so merging a 1024+1024 scores much higher than 2+2.
 */
function mergePotential(board) {
  let m = 0;
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 3; c++)
      if (board[r*4+c] && board[r*4+c] === board[r*4+c+1])
        m += board[r*4+c];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 4; c++)
      if (board[r*4+c] && board[r*4+c] === board[(r+1)*4+c])
        m += board[r*4+c];
  return m;
}

/**
 * Corner bonus — flat reward when max tile is in ANY of the 4 corners.
 * Do NOT restrict to one corner; that causes corner-lock (critical bug fix).
 */
function cornerBonus(board) {
  const max = Math.max(board[0],board[3],board[4],board[5],board[6],board[7],
                       board[8],board[9],board[10],board[11],board[12],board[15],
                       board[1],board[2],board[13],board[14]);
  if (!max) return 0;
  if (board[0] === max || board[3] === max || board[12] === max || board[15] === max)
    return max * 6;
  return 0;
}

/**
 * Adjacency bonus — the second-largest tile should be adjacent to the largest
 * to enable the biggest merge. Rewards proximity between top-2 tiles.
 */
function adjacencyBonus(board) {
  let max = 0, second = 0;
  for (let i = 0; i < 16; i++) {
    if (board[i] > max)         { second = max; max = board[i]; }
    else if (board[i] > second) { second = board[i]; }
  }
  if (!second) return 0;

  let maxIdx = -1, secondIdx = -1;
  for (let i = 0; i < 16; i++) {
    if (board[i] === max    && maxIdx    === -1) maxIdx    = i;
    else if (board[i] === second && secondIdx === -1) secondIdx = i;
  }

  const dist = Math.abs((maxIdx >> 2) - (secondIdx >> 2))
             + Math.abs((maxIdx & 3)  - (secondIdx & 3));
  if (dist === 1) return second * 4;   // adjacent
  if (dist === 2) return second * 1;   // nearby
  return 0;
}

/** Returns true if the board has no valid moves (game over). */
function isTerminal(board) {
  for (const dir of [KEY.LEFT, KEY.RIGHT, KEY.UP, KEY.DOWN]) {
    if (applyMove(board, dir).changed) return false;
  }
  return true;
}

/** Full 7-component evaluation function. */
function evaluate(board) {
  if (isTerminal(board)) return -1e9;
  return (
    snakeScore(board)     * W.snake        +
    emptyCount(board)     * W.empty        +
    monotonicity(board)   * W.monotonicity +
    smoothness(board)     * W.smoothness   +
    mergePotential(board) * W.merge        +
    cornerBonus(board)                     +  // self-weighted
    adjacencyBonus(board)                     // self-weighted
  );
}

// ── Adaptive depth ────────────────────────────────────────────────────────────
// Escalate depth when board is dangerous (fewer empties = worse position).
// Research brief §3.2 / §6.
function adaptDepth(board, base) {
  const empty = emptyCount(board);
  if (empty <= 2)  return base + 2;   // critical — look far ahead
  if (empty <= 4)  return base + 1;   // danger zone
  if (empty >= 12) return Math.max(3, base - 1);  // early game, save compute
  return base;
}

// ── Adjacency-weighted chance node cell sampler ───────────────────────────────
// Instead of random sampling, prioritise empty cells adjacent to high-value tiles.
// A tile spawning next to your 1024 matters far more than one in an isolated corner.
// Research brief §3.3.
function sampleCells(board, maxSamples) {
  const empties = [];
  for (let i = 0; i < 16; i++) {
    if (board[i] !== 0) continue;
    const r = i >> 2, c = i & 3;
    let maxAdj = 0;
    if (r > 0 && board[i-4] > maxAdj) maxAdj = board[i-4];
    if (r < 3 && board[i+4] > maxAdj) maxAdj = board[i+4];
    if (c > 0 && board[i-1] > maxAdj) maxAdj = board[i-1];
    if (c < 3 && board[i+1] > maxAdj) maxAdj = board[i+1];
    empties.push({ i, maxAdj });
  }
  if (empties.length <= maxSamples) return empties.map(e => e.i);
  // Sort by adjacency value (descending) — cells near high tiles first
  empties.sort((a, b) => b.maxAdj - a.maxAdj);
  return empties.slice(0, maxSamples).map(e => e.i);
}

// ── Transposition table ───────────────────────────────────────────────────────
// Cache evaluate() results within a single move decision.
// Hit rate is surprisingly high (many paths reach same board state).
// Cleared before every pickBestMove call.
let TRANS_TABLE = new Map();

// ── Expectimax ────────────────────────────────────────────────────────────────
function expectimax(board, depth, isMax) {
  if (depth === 0) {
    // Leaf node: check cache, then evaluate
    const key = board.join('|');
    let v = TRANS_TABLE.get(key);
    if (v === undefined) {
      v = evaluate(board);
      TRANS_TABLE.set(key, v);
    }
    return v;
  }

  if (isMax) {
    // MAX node: try all 4 directions, take best
    let best = -Infinity;
    for (const dir of DIRS) {
      const { board: nb, changed } = applyMove(board, dir);
      if (!changed) continue;     // only prune truly invalid moves (board unchanged)
      const s = expectimax(nb, depth - 1, false);
      if (s > best) best = s;
    }
    // No valid moves = terminal state
    return best === -Infinity ? evaluate(board) : best;

  } else {
    // CHANCE node: sample empty cells weighted by adjacency to high-value tiles
    const cells = sampleCells(board, CFG.MAX_CHANCE_SAMPLES);
    if (!cells.length) return evaluate(board);

    let total = 0;
    for (const idx of cells) {
      const b2 = board.slice(); b2[idx] = 1;  // place encoded-2 (log2=1)
      total += 0.9 * expectimax(b2, depth - 1, true);
      const b4 = board.slice(); b4[idx] = 2;  // place encoded-4 (log2=2)
      total += 0.1 * expectimax(b4, depth - 1, true);
    }
    return total / cells.length;
  }
}

// ── Pick best move ────────────────────────────────────────────────────────────
function pickBestMove(board) {
  const depth = adaptDepth(board, CFG.BASE_DEPTH);

  // Clear transposition table for this decision (stale entries from last board invalid)
  TRANS_TABLE = new Map();

  let bestDir = -1, bestScore = -Infinity;
  const scores = {};

  // Evaluate all 4 directions — NEVER prune based on heuristic score.
  // Only skip if move produces no board change (genuinely invalid).
  // Research brief §2.3 — this is the #1 fix for the corner-lock bug.
  for (const dir of DIRS) {   // ordered: Up, Left, Down, Right
    const { board: nb, changed } = applyMove(board, dir);
    if (!changed) { scores[DIR_NAME[dir]] = '⛔ blocked'; continue; }
    const s = expectimax(nb, depth - 1, false);
    scores[DIR_NAME[dir]] = Math.round(s).toLocaleString();
    if (s > bestScore) { bestScore = s; bestDir = dir; }
  }

  // Safety fallback: pick any valid move if expectimax returned nothing
  if (bestDir === -1) {
    for (const dir of DIRS) {
      if (applyMove(board, dir).changed) { bestDir = dir; break; }
    }
  }
  if (bestDir === -1) bestDir = KEY.DOWN;

  return { dir: bestDir, score: bestScore, scores, depth };
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

  let dir, scoreInfo, depthUsed;

  if (useAI) {
    const board   = encodeBoard(rawBoard);
    const empty   = emptyCount(board);
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
    console.log(`%cScore: ${domScore ?? '?'}  |  Interval: ${CFG.MOVE_INTERVAL_MS}ms  |  Depth: ${depthUsed}  |  Cache: ${TRANS_TABLE.size}`, 'color:#64748b');
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
    console.log(`   Algorithm:    Expectimax depth ${CFG.BASE_DEPTH} (auto-escalates to ${CFG.BASE_DEPTH+2} in endgame)`);
    console.log(`   Heuristics:   snake(8-sym) + empty×27 + mono + smooth + merge + corner + adjacency`);
    console.log(`   Chance nodes: adjacency-weighted sampling (max ${CFG.MAX_CHANCE_SAMPLES} cells)`);
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
