'use strict';

// ══════════════════════════════════════════════════════════════════════════════
//  2048 Auto-Solver  —  PAGE WORLD  v4.0  (5-bit, Flight Data Recorder)
//
//  Algorithm: Expectimax with dynamic depth (countDistinctTiles - 2)
//  Heuristics: Precomputed HEUR_SCORE_TABLE via 8 lookup operations
//  Chance nodes: Expectimax with threshold pruning (cprob < 0.0001)
//  Tables: 5-bit (1,048,576 entries) precomputed
//  Controls: window.__2048SolverStop() | window.__2048SolverStart()
// ══════════════════════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────────────
//  PART 2: SOLVER  (v4.0 — 5-bit encoding, Flight Data Recorder)
// ──────────────────────────────────────────────────────────────────────
(function () {
  if (window.__2048SolverRunning) {
    console.warn('♻️  [2048] Stopping old solver instance...');
    if (window.__2048SolverStop) window.__2048SolverStop();
  }
  window.__2048SolverRunning = true;

  // ── Config ─────────────────────────────────────────────────────────────
  const CFG = {
    MOVE_INTERVAL_MS  : 150,   // fast early game, self-throttles in late game
    STARTUP_DELAY_MS  : 2000,
    KEYUP_DELAY_MS    : 50,
    DIAG_INTERVAL     : 25,
    DIAG_VERBOSE      : false,
  };

  // ── Key codes ──────────────────────────────────────────────────────────
  const KEY      = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40 };
  const DIRS     = [KEY.UP, KEY.LEFT, KEY.DOWN, KEY.RIGHT];
  const DIR_NAME = { 37: '⬅ LEFT', 38: '⬆ UP', 39: '➡ RIGHT', 40: '⬇ DOWN' };
  const KEY_STR  = { 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown' };

  // ── Send keyboard event ────────────────────────────────────────────────
  function fireKey(type, code) {
    const event = new KeyboardEvent(type, {
      bubbles: true, cancelable: true,
      key: KEY_STR[code], code: KEY_STR[code],
      keyCode: code, which: code,
    });
    document.dispatchEvent(event);
    if (typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(event);
    }
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
    if (board) { boardStrategy = 'worker';       return { board, strategy: 'worker' }; }
    board = readBoardLocalStorage();
    if (board) { boardStrategy = 'localStorage'; return { board, strategy: 'localStorage' }; }
    board = readBoardDOM();
    if (board) { boardStrategy = 'dom';          return { board, strategy: 'dom' }; }

    return { board: null, strategy: 'cycle' };
  }

  // ── Board encoding (5-bit: supports tiles up to 131072) ───────────────
  const ENC = { 0:0,2:1,4:2,8:3,16:4,32:5,64:6,128:7,256:8,512:9,
                1024:10,2048:11,4096:12,8192:13,16384:14,32768:15,65536:16,131072:17 };
  const DEC = [0,2,4,8,16,32,64,128,256,512,1024,2048,4096,8192,16384,32768,65536,131072];

  function encodeBoard(raw) {
    return raw.map(v => ENC[v] ?? (v > 0 ? Math.min(17, Math.round(Math.log2(v))) : 0));
  }

  // ── Precomputed Tables (nneonneo style, 5-bit encoding) ───────────────
  // 5 bits per cell × 4 cells = 20 bits → 2^20 = 1,048,576 entries
  const TABLE_SIZE = 1048576;
  const ROW_LEFT_TABLE  = new Uint32Array(TABLE_SIZE);
  const HEUR_SCORE_TABLE = new Float32Array(TABLE_SIZE);
  const SCORE_TABLE     = new Float32Array(TABLE_SIZE);

  function initTables() {
    const SCORE_LOST_PENALTY        = 200000.0;
    const SCORE_MONOTONICITY_POWER  = 4.0;
    const SCORE_MONOTONICITY_WEIGHT = 47.0;
    const SCORE_SUM_POWER           = 3.5;
    const SCORE_SUM_WEIGHT          = 11.0;
    const SCORE_MERGES_WEIGHT       = 700.0;
    const SCORE_EMPTY_WEIGHT        = 270.0;
    const MAX_RANK = 17; // 2^17 = 131,072

    for (let a = 0; a <= MAX_RANK; a++) {
      for (let b = 0; b <= MAX_RANK; b++) {
        for (let c = 0; c <= MAX_RANK; c++) {
          for (let d = 0; d <= MAX_RANK; d++) {
            const row = a | (b << 5) | (c << 10) | (d << 15);
            const line = [a, b, c, d];

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
                if (line[i] !== MAX_RANK) {
                  line[i]++;
                }
                line[j] = 0;
              }
            }

            ROW_LEFT_TABLE[row] = line[0] | (line[1] << 5) | (line[2] << 10) | (line[3] << 15);
          }
        }
      }
    }
  }

  function scoreHeurBoard(board) {
    return HEUR_SCORE_TABLE[board[0]  | (board[1]  << 5) | (board[2]  << 10) | (board[3]  << 15)] +
           HEUR_SCORE_TABLE[board[4]  | (board[5]  << 5) | (board[6]  << 10) | (board[7]  << 15)] +
           HEUR_SCORE_TABLE[board[8]  | (board[9]  << 5) | (board[10] << 10) | (board[11] << 15)] +
           HEUR_SCORE_TABLE[board[12] | (board[13] << 5) | (board[14] << 10) | (board[15] << 15)] +
           HEUR_SCORE_TABLE[board[0]  | (board[4]  << 5) | (board[8]  << 10) | (board[12] << 15)] +
           HEUR_SCORE_TABLE[board[1]  | (board[5]  << 5) | (board[9]  << 10) | (board[13] << 15)] +
           HEUR_SCORE_TABLE[board[2]  | (board[6]  << 5) | (board[10] << 10) | (board[14] << 15)] +
           HEUR_SCORE_TABLE[board[3]  | (board[7]  << 5) | (board[11] << 10) | (board[15] << 15)];
  }

  function buildCache() {
    console.log('%c📐 [2048] Initializing 5-bit precomputed tables (1M entries)...', 'color:#818cf8');
    const startTime = performance.now();
    initTables();
    const elapsed = performance.now() - startTime;
    console.log(`%c📐 [2048] Tables ready in ${elapsed.toFixed(0)}ms (${(TABLE_SIZE).toLocaleString()} entries)`, 'color:#818cf8');
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
      const key = board[i0] | (board[i1] << 5) | (board[i2] << 10) | (board[i3] << 15);
      const resVal = ROW_LEFT_TABLE[key];
      const r0 = resVal & 0x1f;
      const r1 = (resVal >> 5) & 0x1f;
      const r2 = (resVal >> 10) & 0x1f;
      const r3 = (resVal >> 15) & 0x1f;
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

    const elapsedMs = performance.now() - startTime;
    const elapsed = elapsedMs / 1000.0;
    console.log(`[2048] AI Move: best = ${DIR_NAME[bestDir]}, eval'd ${state.movesEvaled} nodes (${state.cacheHits} cache hits, cache ${state.transTable.size}) in ${elapsed.toFixed(3)}s (depth=${state.maxDepth})`);

    if (bestDir === -1) {
      for (const dir of DIRS) {
        if (applyMove(board, dir).changed) {
          bestDir = dir;
          break;
        }
      }
    }
    if (bestDir === -1) bestDir = KEY.DOWN;

    return { dir: bestDir, score: bestScore, scores, depth: depthLimit, calcTimeMs: elapsedMs };
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
        row.push(String(v===0?'·':v).padStart(7));
      }
      out+='  '+row.join(' ')+'\n';
    }
    return out;
  }

  // ── Game Over Detection ────────────────────────────────────────────────
  function detectGameOver(board) {
    for (let move = 0; move < 4; ++move) {
      const { changed } = applyMove(board, DIRS[move]);
      if (changed) return false;
    }
    return true;
  }

  function detectGameOverDOM() {
    return document.querySelector('.game-over') !== null;
  }

  // ── Flight Data Recorder ──────────────────────────────────────────────
  const gameHistory = [];
  let sessionStartTime = null;

  function downloadHistory(summary) {
    try {
      const finalScore = summary.finalScore || 0;
      const date = new Date().toISOString().slice(0, 10);
      const filename = `2048_session_${finalScore}_${date}.json`;
      const blob = new Blob([JSON.stringify(summary, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      console.log(`%c📥 [2048] Game history downloaded as: ${filename}`, 'color:#4ade80; font-weight:bold');
    } catch (err) {
      console.error('[2048] Failed to download history:', err);
    }
  }

  function onGameOver(board, rawBoard) {
    stopSolver();
    const domScore = readScoreDOM();
    const maxTile = DEC[Math.max(...board)] || 0;

    const summary = {
      finalScore: domScore ?? window.__2048State?.score ?? 0,
      totalMoves: moveCount,
      maxTileReached: maxTile,
      sessionDurationMs: sessionStartTime ? Date.now() - sessionStartTime : 0,
      date: new Date().toISOString(),
      moves: gameHistory
    };

    window.__2048GameHistory = summary;

    console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color:#f87171');
    console.log('%c💀  2048 SOLVER  —  GAME OVER', 'color:#f87171; font-size:16px; font-weight:bold');
    console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color:#f87171');
    console.log(`   Final Score:    ${(summary.finalScore).toLocaleString()}`);
    console.log(`   Max Tile:       ${maxTile.toLocaleString()}`);
    console.log(`   Total Moves:    ${moveCount}`);
    console.log(`   Duration:       ${(summary.sessionDurationMs / 1000).toFixed(1)}s`);
    console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color:#f87171');
    console.log('%c📋 Full game history: window.__2048GameHistory', 'color:#38bdf8');
    console.log('%c📋 Copy with: copy(JSON.stringify(window.__2048GameHistory))', 'color:#38bdf8');

    downloadHistory(summary);
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
    if (document.hidden) return;
    moveCount++;
    const { board: rawBoard, strategy } = readBoard();
    const useAI = rawBoard !== null;

    let dir, scoreInfo;

    if (useAI) {
      const board  = encodeBoard(rawBoard);
      const empty  = board.filter(v=>v===0).length;
      const maxTile = DEC[Math.max(...board)] || 0;

      // Game over check (algorithmic)
      if (detectGameOver(board)) {
        onGameOver(board, rawBoard);
        return;
      }

      if (lastEncBoard && board.every((v,i)=>v===lastEncBoard[i])) {
        stuckCount++;
        if (stuckCount>=3) {
          console.warn(`%c🔄 [2048] Stuck ${stuckCount} ticks — forcing safe unstuck move`, 'color:#f87171');
          for (const d of [KEY.DOWN, KEY.RIGHT, KEY.LEFT, KEY.UP]) {
            if (applyMove(board, d).changed) {
              dir = d;
              break;
            }
          }
        }
      } else {
        stuckCount = 0;
      }
      lastEncBoard = board.slice();

      let depthUsed = 0;
      let calcTimeMs = 0;
      if (!dir) {
        const res = pickBestMove(board);
        dir       = res.dir;
        scoreInfo = res.scores;
        depthUsed = res.depth;
        calcTimeMs = res.calcTimeMs;
      }

      const domScore = readScoreDOM();
      const st = window.__2048State;

      // Record move in Flight Data Recorder
      gameHistory.push({
        step: moveCount,
        timestamp: Date.now(),
        board: rawBoard.slice(),
        encodedBoard: board.slice(),
        maxTile,
        empty,
        move: DIR_NAME[dir],
        scores: scoreInfo,
        depth: depthUsed,
        calcTimeMs: Math.round(calcTimeMs * 100) / 100,
        gameScore: domScore ?? st?.score ?? 0,
        strategy
      });

      console.groupCollapsed(
        `%c[2048] #${moveCount}  ${DIR_NAME[dir].padEnd(10)}  🏆 ${String(maxTile).padStart(6)}  🟩 ${empty}/16  📡 ${strategy}`,
        'color:#4ade80; font-weight:bold; font-family:monospace'
      );
      console.log('%cBoard state:\n' + renderBoard(board), 'color:#94a3b8; font-family:monospace');
      if (scoreInfo) {
        console.log('%cExpectimax scores per direction:', 'color:#94a3b8');
        console.table(scoreInfo);
      }
      console.log(
        `%cScore: ${domScore ?? st?.score ?? '?'}  |  Interval: ${CFG.MOVE_INTERVAL_MS}ms  |  Depth: ${depthUsed}  |  Calc: ${calcTimeMs.toFixed(1)}ms`,
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

      // Reset flight data recorder
      gameHistory.length = 0;
      sessionStartTime = Date.now();
      moveCount = 0;
      stuckCount = 0;
      lastEncBoard = null;

      const { board: testBoard, strategy } = readBoard();

      console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color:#475569');
      console.log('%c🎮  2048 SOLVER v4.0  —  STARTED', 'color:#f59e0b; font-size:16px; font-weight:bold');
      console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color:#475569');

      if (testBoard) {
        console.log(`   Mode:      🧠 Expectimax AI  (source: ${strategy})`);
      } else {
        console.log('   Mode:      🔁 Cycle fallback');
        console.log('   Reason:    Worker messages not yet captured.');
        console.log('   ➡ If this persists, reload the page (do not just reload extension).');
      }

      console.log(`   Encoding:  5-bit (supports tiles up to 131,072)`);
      console.log(`   Algorithm: Expectimax with dynamic depth (countDistinctTiles - 2)`);
      console.log('   Heuristics: Precomputed HEUR_SCORE_TABLE via 8 lookup operations');
      console.log(`   Pruning:   Threshold cprob < 0.0001`);
      console.log(`   Tables:    ${TABLE_SIZE.toLocaleString()} entries per table`);
      console.log(`   Interval:  ${CFG.MOVE_INTERVAL_MS}ms`);
      console.log(`   Recorder:  ✅ Flight Data Recorder active (auto-downloads on game over)`);
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
    console.log('History size: ', gameHistory.length, 'moves recorded');

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

  console.log('%c🚀 [2048] solver v4.0 loaded (5-bit, Flight Data Recorder) — run window.__2048Status() to check board reading', 'color:#818cf8; font-weight:bold');
  startSolver();
})();
