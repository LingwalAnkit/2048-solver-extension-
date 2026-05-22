# 2048 Solver Optimization — Research Brief for Agent

## Mission
Produce a JavaScript 2048 solver that consistently scores **80,000–150,000+ points**, reaches the **4096 tile reliably** and the **8192 tile frequently**. The current human-written solver plateaus at ~14,000 points. A prior Claude-generated solver peaked at 60,000. This document contains everything an agent needs to write a state-of-the-art implementation.

---

## 1. Problem Formulation

### 1.1 Game Rules
- 4×4 grid, 16 cells
- Each turn: player chooses one of 4 directions (left / right / up / down)
- All tiles slide maximally in that direction; equal adjacent tiles merge (once per move)
- After every valid move: one new tile spawns in a **uniformly random empty cell**, value = 2 (p=0.9) or 4 (p=0.1)
- Score += sum of all merged tile values that move
- Game over when no valid move exists (board full, no adjacent equals)
- Theoretical maximum tile on 4×4: **131,072**

### 1.2 Why It's Hard
- Stochastic: random tile placement introduces branching factor that grows exponentially
- Deceptively local: a greedy "merge as much as possible now" strategy fails catastrophically
- Corner traps: locking the max tile in a corner reduces playable directions from 4 to 2 — **this is the #1 flaw in naive solvers**

---

## 2. The Corner-Lock Problem (Critical Flaw to Fix)

### 2.1 What Naive Solvers Do Wrong
Most beginner implementations apply a static snake-weight matrix that heavily penalises moves away from the designated corner. This causes the solver to:

1. Lock the max tile (e.g. 1024) into the top-left corner
2. Refuse to play `right` or `down` because they score poorly against the weight matrix
3. Get trapped: when the only valid merge requires sliding away from the corner, the solver either picks a suboptimal move or finds no valid move at all
4. Die with a nearly-winning board because it couldn't make 2 out of 4 moves

### 2.2 The Fix: Flexible Corner Strategy
**Do not hard-lock to one corner.** Instead:

- Evaluate the board against **all 8 symmetries** (4 rotations × 2 reflections) of the snake matrix
- Take the maximum score across all symmetries
- This lets the solver adapt — if tiles have naturally built toward the bottom-right, it plays bottom-right strategy without fighting the board

### 2.3 The Fix: Move Pruning Must Be Conditional
Never prune a direction just because it scores low on the heuristic. Only prune if the move produces **no change** to the board (i.e. `moved === false`). A low-scoring move may be the only survival move.

---

## 3. Search Algorithm: Expectimax

### 3.1 Algorithm Structure
```
expectimax(board, depth, isMaxNode):
  if depth == 0: return evaluate(board)

  if isMaxNode:
    best = -∞
    for each direction d in [0,1,2,3]:
      (newBoard, moved) = applyMove(board, d)
      if not moved: continue
      val = expectimax(newBoard, depth-1, false)
      best = max(best, val)
    return best (or evaluate(board) if no valid move)

  else (chance node):
    empties = all empty cells
    total = 0
    for each empty cell position p:
      for (tileVal, prob) in [(2, 0.9), (4, 0.1)]:
        newBoard = board with tileVal placed at p
        total += prob * expectimax(newBoard, depth-1, true)
    return total / len(empties)
```

### 3.2 Depth Selection
| Depth | Avg time/move | Typical max tile |
|---|---|---|
| 3 | ~5ms | 512–1024 |
| 4 | ~20ms | 1024–2048 |
| 5 | ~80ms | 2048–4096 |
| 6 | ~300ms | 4096–8192 |
| 7 | ~1200ms | 8192+ |

**Recommended**: depth 5 default, auto-escalate to 6 when empty cells ≤ 4, to 7 when empty cells ≤ 2.

### 3.3 Chance Node Sampling (Critical for Speed)
Full enumeration of chance nodes is O(empties × 2) per level — at 10 empty cells and depth 6, this is 2^6 × 20 = 1280 leaf evaluations per move. Too slow without sampling.

**Smart sampling strategy** (better than random):
- When empties > 6: sample the 4–6 cells **most adjacent to high-value tiles** (these spawns matter most)
- When empties ≤ 4: enumerate ALL cells (critical endgame, don't miss anything)
- Always include both tile values (2 and 4) for each sampled cell

**Why adjacency-weighted sampling beats random**: A tile spawning next to your 1024 drastically changes the board's merge potential. A tile spawning in an isolated empty corner is nearly irrelevant. Sampling by adjacency value focuses compute where it matters.

```js
function sampleCells(board, maxSamples) {
  const empties = [];
  for (let i = 0; i < 16; i++) {
    if (board[i] !== 0) continue;
    const r = Math.floor(i / 4), c = i % 4;
    let maxAdj = 0;
    if (r > 0 && board[i-4]) maxAdj = Math.max(maxAdj, board[i-4]);
    if (r < 3 && board[i+4]) maxAdj = Math.max(maxAdj, board[i+4]);
    if (c > 0 && board[i-1]) maxAdj = Math.max(maxAdj, board[i-1]);
    if (c < 3 && board[i+1]) maxAdj = Math.max(maxAdj, board[i+1]);
    empties.push({ i, maxAdj });
  }
  if (empties.length <= maxSamples) return empties.map(e => e.i);
  return empties
    .sort((a, b) => b.maxAdj - a.maxAdj)
    .slice(0, maxSamples)
    .map(e => e.i);
}
```

---

## 4. Heuristic Evaluation Function

The evaluation function is called at every leaf node. It must be **fast** (called thousands of times per move) and **accurate** (must correlate with eventual game outcome).

### 4.1 Component Breakdown

#### A. Snake / Gradient Score (Weight: 1.0–1.5)
Reward boards where tile values decrease monotonically from one corner following a snake path.

**Implementation**: Try all 8 symmetries of the weight matrix, take the max.

```
Snake matrix (one of 8):
15  14  13  12
 8   9  10  11
 7   6   5   4
 0   1   2   3

score = Σ log2(tile[i]) × snakeWeight[i]   (skip empty cells)
```

The 8 symmetries cover all 4 corners × 2 reflection orientations:
- TL-snake, TR-snake, BL-snake, BR-snake
- TL-snake-reflected, TR-snake-reflected, BL-snake-reflected, BR-snake-reflected

#### B. Empty Cell Count (Weight: 25–35)
`emptyScore = count(board == 0)`

This is the single most important term. The solver must be aggressively board-clearing. An empty board has near-infinite options; a full board is death.

**Critical**: weight this between 25 and 35. Anything below 15 causes the solver to ignore board congestion.

#### C. Monotonicity (Weight: 1.2–1.8)
Penalise rows/columns that are not monotonically ordered (either always increasing or always decreasing).

```js
function monotonicity(board) {
  let penalty = 0;
  // rows
  for (let r = 0; r < 4; r++) {
    let inc = 0, dec = 0;
    for (let c = 0; c < 3; c++) {
      const a = board[r*4+c] ? Math.log2(board[r*4+c]) : 0;
      const b = board[r*4+c+1] ? Math.log2(board[r*4+c+1]) : 0;
      if (a > b) dec += a - b; else inc += b - a;
    }
    penalty -= Math.min(inc, dec);
  }
  // columns (same pattern)
  for (let c = 0; c < 4; c++) {
    let inc = 0, dec = 0;
    for (let r = 0; r < 3; r++) {
      const a = board[r*4+c] ? Math.log2(board[r*4+c]) : 0;
      const b = board[(r+1)*4+c] ? Math.log2(board[(r+1)*4+c]) : 0;
      if (a > b) dec += a - b; else inc += b - a;
    }
    penalty -= Math.min(inc, dec);
  }
  return penalty;
}
```

#### D. Smoothness (Weight: 0.3–0.6)
Penalise large value jumps between adjacent tiles (makes merging easier if neighbors are similar).

```js
function smoothness(board) {
  let s = 0;
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 3; c++)
      if (board[r*4+c] && board[r*4+c+1])
        s -= Math.abs(Math.log2(board[r*4+c]) - Math.log2(board[r*4+c+1]));
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 4; c++)
      if (board[r*4+c] && board[(r+1)*4+c])
        s -= Math.abs(Math.log2(board[r*4+c]) - Math.log2(board[(r+1)*4+c]));
  return s;
}
```

#### E. Merge Potential (Weight: 2.0–3.5)
Reward boards with many adjacent equal tiles — these are "free merges" waiting to happen.

```js
function mergePotential(board) {
  let m = 0;
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 3; c++)
      if (board[r*4+c] && board[r*4+c] === board[r*4+c+1])
        m += Math.log2(board[r*4+c]);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 4; c++)
      if (board[r*4+c] && board[r*4+c] === board[(r+1)*4+c])
        m += Math.log2(board[r*4+c]);
  return m;
}
```

#### F. Max Tile Corner Bonus (Weight: flat 4–8 × log2(maxTile))
Large flat reward when the maximum tile is in ANY of the 4 corners. Do NOT restrict to one corner.

```js
function cornerBonus(board) {
  const max = Math.max(...board);
  if (!max) return 0;
  const corners = [0, 3, 12, 15];
  return corners.some(i => board[i] === max) ? Math.log2(max) * 6 : 0;
}
```

#### G. Second-Largest Tile Edge Bonus (NEW — often missing)
The second-largest tile should be adjacent to the largest tile (to enable the biggest merge). Reward the second-largest being on the same edge or adjacent to max tile.

```js
function adjacencyBonus(board) {
  const vals = [...board].sort((a,b) => b-a);
  const max = vals[0], second = vals[1];
  if (!second) return 0;
  const maxIdx = board.indexOf(max);
  const secondIdx = board.indexOf(second);
  const mr = Math.floor(maxIdx/4), mc = maxIdx%4;
  const sr = Math.floor(secondIdx/4), sc = secondIdx%4;
  const dist = Math.abs(mr-sr) + Math.abs(mc-sc);
  if (dist === 1) return Math.log2(second) * 4;   // adjacent
  if (dist === 2) return Math.log2(second) * 1;   // close
  return 0;
}
```

### 4.2 Final Evaluation Formula
```js
function evaluate(board) {
  if (isGameOver(board)) return -1e9;
  return (
    snakeScore(board)      * 1.2  +
    emptyCount(board)      * 27   +
    monotonicity(board)    * 1.5  +
    smoothness(board)      * 0.4  +
    mergePotential(board)  * 2.5  +
    cornerBonus(board)            +   // flat, pre-weighted inside function
    adjacencyBonus(board)             // flat, pre-weighted inside function
  );
}
```

### 4.3 Tuning These Weights
The weights above are derived from published analyses of high-scoring 2048 bots. If the agent wants to auto-tune, use a simple hill-climbing loop: run N games, measure average score, perturb one weight by ±10%, repeat. Prioritise tuning `emptyCount` weight (most sensitive) and `snakeScore` weight second.

---

## 5. Move Ordering Optimisation

Evaluate moves in this order to find good moves early (prunes bad branches faster):
1. **Up** — consolidates toward top, sets up corner
2. **Left** — consolidates toward left
3. **Down**
4. **Right**

Do NOT hard-exclude any direction. All 4 must be tried unless `moved === false`.

---

## 6. Adaptive Depth Strategy

```js
function getDepth(board, baseDepth) {
  const empty = board.filter(v => v === 0).length;
  if (empty <= 2) return baseDepth + 2;  // critical — look far ahead
  if (empty <= 4) return baseDepth + 1;  // danger zone
  if (empty >= 12) return baseDepth - 1; // early game, save compute
  return baseDepth;
}
```

---

## 7. Performance Optimisations

### 7.1 Bitboard Representation (Advanced)
Instead of a 16-element JS array, encode the entire board as a single 64-bit integer (each cell = 4 bits, log2 of value). This makes cloning O(1) and enables precomputed row-move lookup tables.

For a JS implementation, use two 32-bit integers or BigInt (BigInt has overhead, two Int32 is faster).

### 7.2 Precomputed Row Moves
There are only 2^16 = 65536 possible row states. Precompute a lookup table at startup:
```
LEFT_TABLE[rowState] = { newRow, score }
```
Then each move is 4 table lookups instead of iterating and merging — ~10x faster per move evaluation.

### 7.3 Web Worker
At depth 6+, the Expectimax call takes 200–400ms. Run it in a Web Worker to avoid freezing the page, then `postMessage` the result back.

```js
// worker.js
self.onmessage = function(e) {
  const { board, depth } = e.data;
  const dir = pickMove(board, depth);
  self.postMessage(dir);
};

// content.js
const worker = new Worker('worker.js');
worker.postMessage({ board: readBoard(), depth: 6 });
worker.onmessage = e => sendMove(e.data);
```

### 7.4 Transposition Table (Optional but Powerful)
Cache `evaluate(board)` results. Use a Map with board state as key (JSON.stringify or a hash). Hit rate is surprisingly high because many move sequences reach the same board state.

```js
const cache = new Map();
function cachedEval(board) {
  const key = board.join(',');
  if (cache.has(key)) return cache.get(key);
  const v = evaluate(board);
  cache.set(key, v);
  return v;
}
// Clear cache every N moves to avoid memory bloat
```

---

## 8. Known Failure Modes and Fixes

| Failure | Cause | Fix |
|---|---|---|
| Solver gets stuck, max tile not in corner | Snake weight too weak | Increase snake weight to 1.5+, ensure all 8 symmetries tested |
| Board fills up fast, solver panics | Empty cell weight too low | Set empty weight ≥ 25 |
| Large tiles scattered across board | Adjacency not rewarded | Add adjacencyBonus component |
| Only 2 directions ever chosen | Corner lock eliminating moves | NEVER prune based on heuristic score — only prune `moved === false` |
| Solver merges small tiles, ignores big setups | Merge weight only counts immediate pairs | Add a "merge chain" bonus for 3–4 tiles that could cascade |
| Score caps at ~20k | Depth too shallow | Use depth 5 minimum, 6 in endgame |
| Solver is slow at depth 6 | No optimisation | Add precomputed row table or Web Worker |

---

## 9. What the Agent Must Implement

### Mandatory
- [ ] `applyMove(board, dir)` → `{ board, score, moved }` — flat 16-array, all 4 directions
- [ ] `expectimax(board, depth, isMax)` — with adjacency-weighted chance node sampling
- [ ] `evaluate(board)` — all 7 components listed in Section 4
- [ ] `snakeScore(board)` — must test all 8 symmetries, not just 4
- [ ] `adaptDepth(board, base)` — escalate on low empty count
- [ ] `pickMove(board, depth)` — tries all 4 directions, never hard-prunes
- [ ] `sampleCells(board, n)` — adjacency-ranked sampling

### Strongly Recommended
- [ ] Precomputed row-move lookup table (10x speed boost)
- [ ] Web Worker integration for non-blocking UI
- [ ] Transposition table with periodic clearing

### Target Metrics
| Metric | Minimum | Good | Excellent |
|---|---|---|---|
| Average score | 30,000 | 60,000 | 100,000+ |
| Max tile (median) | 2048 | 4096 | 8192 |
| 2048 tile reach rate | 90% | — | — |
| 4096 tile reach rate | 40% | 70% | — |
| ms per move (depth 5) | <150 | <80 | <30 |

---

## 10. Reference Weight Configuration (Proven at 60k+)

These weights produced 60,000+ scores in testing. Agent should start here and tune upward:

```js
const WEIGHTS = {
  snake:       1.2,
  empty:       27,
  monotonicity: 1.5,
  smoothness:  0.4,
  merge:       2.5,
  // cornerBonus and adjacencyBonus are self-weighted inside their functions
};
const BASE_DEPTH = 5;
const MAX_SAMPLES_CHANCE = 8;  // chance node cell sampling limit
```

To push beyond 60k, increase `empty` toward 35 and `merge` toward 3.5 first — these have the highest leverage on late-game survival.

---

## 11. Summary for Agent

> The solver must use Expectimax search at depth 5–7 with adaptive depth escalation. The heuristic must include all 7 components especially the adjacency bonus and all-8-symmetry snake score. The corner-lock bug — where only 2 of 4 moves are ever considered — must be explicitly prevented by never pruning moves based on heuristic score. Chance nodes must sample empty cells ranked by adjacency to high-value tiles. For performance, implement a precomputed row-move lookup table. Target: consistent 4096 tiles, occasional 8192 tiles, average score above 80,000.
