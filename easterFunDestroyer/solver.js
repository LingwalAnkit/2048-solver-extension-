'use strict';

// ══════════════════════════════════════════════════════════════════════
//  2048 Auto-Solver  —  PAGE WORLD
//  Reads live board state from window.__2048State (set by interceptor.js)
//  Falls back to DOM or cycle strategy if worker messages not yet parsed.
//
//  Algorithm: Expectimax with 5-heuristic evaluation
//    1. Empty cells      — space = survival
//    2. Snake gradient   — large tiles in Z-path (top-left anchor)
//    3. Monotonicity     — rows/cols sorted = no blocking
//    4. Merge potential  — adjacent equal tiles = cheap merges
//    5. Corner bonus     — max tile in corner
// ══════════════════════════════════════════════════════════════════════

if (window.__2048SolverRunning) {
  console.warn('♻️  [2048] Stopping old solver instance...');
  if (window.__2048SolverStop) window.__2048SolverStop();
}
window.__2048SolverRunning = true;

// ── Config ─────────────────────────────────────────────────────────────
const CFG = {
  MOVE_INTERVAL_MS : 300,  // faster speed as requested
  EXPECTIMAX_DEPTH : 4,
  STARTUP_DELAY_MS : 2000,  // give the game + interceptor time to boot
  KEYUP_DELAY_MS   : 60,
  DIAG_INTERVAL    : 20,    // print full diagnostics every N moves
};

// ── Key codes ──────────────────────────────────────────────────────────
const KEY      = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40 };
const DIRS     = [KEY.UP, KEY.LEFT, KEY.DOWN, KEY.RIGHT];
const DIR_NAME = { 37: '⬅ LEFT', 38: '⬆ UP', 39: '➡ RIGHT', 40: '⬇ DOWN' };
const KEY_STR  = { 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown' };

// ── Send keyboard event (ONCE to document — no triple dispatch) ────────
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
  // Try common score element patterns across Svelte / React 2048 versions
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

// Strategy A: Worker interception (best — reads real board state)
function readBoardWorker() {
  const st = window.__2048State;
  if (!st || !st.board) return null;
  // Stale data guard: reject if not updated in the last 10 seconds
  if (Date.now() - st.lastUpdate > 10_000) return null;
  const b = st.board;
  if (!Array.isArray(b) || b.length !== 16) return null;
  if (!b.some(v => v > 0)) return null;
  return b;
}

// Strategy B: Classic DOM tile elements (.tile-position-{col}-{row})
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

  // Probe all strategies
  board = readBoardWorker();
  if (board) { boardStrategy = 'worker'; return { board, strategy: 'worker' }; }
  board = readBoardDOM();
  if (board) { boardStrategy = 'dom';    return { board, strategy: 'dom' }; }

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

// ── Heuristics ─────────────────────────────────────────────────────────
function computeSmoothness(board) {
  let smoothness = 0;
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const index = row * 4 + col;
      const value = board[index];
      if (value > 0) {
        // Look to the right
        for (let nextCol = col + 1; nextCol < 4; nextCol++) {
          const nextIndex = row * 4 + nextCol;
          const nextValue = board[nextIndex];
          if (nextValue > 0) {
            smoothness -= Math.abs(value - nextValue);
            break;
          }
        }
        // Look down
        for (let nextRow = row + 1; nextRow < 4; nextRow++) {
          const nextIndex = nextRow * 4 + col;
          const nextValue = board[nextIndex];
          if (nextValue > 0) {
            smoothness -= Math.abs(value - nextValue);
            break;
          }
        }
      }
    }
  }
  return smoothness;
}

function computeMonotonicity(board) {
  const totals = [0, 0, 0, 0];

  // Up/down direction (vertical columns)
  for (let col = 0; col < 4; col++) {
    let current = 0;
    let next = current + 1;
    while (next < 4) {
      while (next < 4 && board[next * 4 + col] === 0) {
        next++;
      }
      if (next >= 4) {
        next--;
      }
      const currentValue = board[current * 4 + col];
      const nextValue = board[next * 4 + col];
      if (currentValue > nextValue) {
        totals[0] += nextValue - currentValue;
      } else if (nextValue > currentValue) {
        totals[1] += currentValue - nextValue;
      }
      current = next;
      next++;
    }
  }

  // Left/right direction (horizontal rows)
  for (let row = 0; row < 4; row++) {
    let current = 0;
    let next = current + 1;
    while (next < 4) {
      while (next < 4 && board[row * 4 + next] === 0) {
        next++;
      }
      if (next >= 4) {
        next--;
      }
      const currentValue = board[row * 4 + current];
      const nextValue = board[row * 4 + next];
      if (currentValue > nextValue) {
        totals[2] += nextValue - currentValue;
      } else if (nextValue > currentValue) {
        totals[3] += currentValue - nextValue;
      }
      current = next;
      next++;
    }
  }

  return Math.max(totals[0], totals[1]) + Math.max(totals[2], totals[3]);
}

function heuristic(board) {
  let emptyCells = 0;
  for (let i = 0; i < 16; i++) {
    if (board[i] === 0) emptyCells++;
  }

  const smoothness = computeSmoothness(board);
  const monotonicity = computeMonotonicity(board);
  const maxValue = Math.max(...board);
  const emptyCellsLog = emptyCells > 0 ? Math.log(emptyCells) : -8.0;

  const smoothWeight = 0.1;
  const mono2Weight  = 1.0;
  const emptyWeight  = 2.7;
  const maxWeight    = 1.0;

  return smoothness * smoothWeight +
         monotonicity * mono2Weight +
         emptyCellsLog * emptyWeight +
         maxValue * maxWeight;
}

// ── Expectimax ─────────────────────────────────────────────────────────
function expectimax(board, depth, isMax) {
  if (depth === 0) return heuristic(board);
  if (isMax) {
    let best = -Infinity;
    for (const dir of DIRS) {
      const {board: nb, changed} = applyMove(board, dir);
      if (!changed) continue;
      const s = expectimax(nb, depth - 1, false);
      if (s > best) best = s;
    }
    return best === -Infinity ? 0 : best;
  } else {
    const empties = [];
    for (let i = 0; i < 16; i++) if (board[i] === 0) empties.push(i);
    if (!empties.length) return heuristic(board);
    const cells = empties.length > 5 ? empties.slice(0, 5) : empties;
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
  const empty = board.filter(v => v === 0).length;
  let depth = 4; // Base depth
  if (empty <= 2) {
    depth = 6;
  } else if (empty <= 4) {
    depth = 5;
  }

  let bestDir = KEY.DOWN, bestScore = -Infinity;
  const scores = {};
  for (const dir of DIRS) {
    const {board: nb, changed} = applyMove(board, dir);
    if (!changed) { scores[DIR_NAME[dir]] = '⛔ blocked'; continue; }
    const s = expectimax(nb, depth - 1, false);
    scores[DIR_NAME[dir]] = Math.round(s).toLocaleString();
    if (s > bestScore) { bestScore = s; bestDir = dir; }
  }
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
    console.log('Current board values:', st.board);
  }
  console.log('Score captured:', st.score);
  console.log('Last update ago:', st.lastUpdate ? `${Date.now()-st.lastUpdate}ms` : 'never');
  
  console.log('Incoming Types:', st.incomingTypes);
  console.log('Event Names:', st.eventNames);
  console.log('Event Samples:', st.eventSamples);
  console.log('Response Samples:', st.responseSamples);
  
  console.log('Outgoing Types:', st.outgoingTypes);
  console.log('Call Names:', st.callNames);
  console.log('Call Samples:', st.callSamples);

  if (st.lastIncoming && st.lastIncoming.length > 0) {
    console.groupCollapsed('Last 5 Incoming Messages (Worker -> Main)');
    st.lastIncoming.slice(-5).forEach((m, i) => console.log(`  [Incoming -${5-i}]`, m));
    console.groupEnd();
  }
  if (st.lastOutgoing && st.lastOutgoing.length > 0) {
    console.groupCollapsed('Last 5 Outgoing Messages (Main -> Worker)');
    st.lastOutgoing.slice(-5).forEach((m, i) => console.log(`  [Outgoing -${5-i}]`, m));
    console.groupEnd();
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

    // Stuck detection
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

    // ── Console log ──────────────────────────────────────────────────
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

    // Periodic full diagnostics
    if (moveCount % CFG.DIAG_INTERVAL === 0) printDiagnostics();

  } else {
    // Cycle fallback
    dir = nextCycleMove();
    if (moveCount % 5 === 0) {
      console.log(
        `%c[2048] #${moveCount}  ${DIR_NAME[dir]}  🔁 Cycle (worker not yet readable)`,
        'color:#f59e0b; font-family:monospace'
      );
    }
    // Print diagnostics more often while we can't read the board
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

    console.log(`   Algorithm: Expectimax depth-${CFG.EXPECTIMAX_DEPTH}`);
    console.log('   Heuristics: empty(log-space) + smoothness + monotonicity + maxValue');
    console.log(`   Interval:  ${CFG.MOVE_INTERVAL_MS}ms`);
    console.log(`   Controls:  window.__2048SolverStop()  |  window.__2048SolverStart()`);
    console.log(`   Debug:     window.__2048State  (live board from worker)`);
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
window.addEventListener('message', e => {
  if (!e.data?.__2048Solver) return;
  if (e.data.action==='stop')  stopSolver();
  if (e.data.action==='start') startSolver();
});

console.log('%c🚀 [2048] solver.js loaded in page world', 'color:#818cf8; font-weight:bold');
startSolver();
