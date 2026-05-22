# 2048 Solver → Browser Extension — Agent Brief

## Goal
Build a Chrome extension that overlays on https://play2048.co/ and auto-plays the game using a pure-algorithm solver (no AI/ML), achieving high scores (target: 8192+ tile).

---

## Context: What Was Already Built

A working 2048 solver was iteratively developed and tested in-browser. Final version achieved **60,000+ points** consistently.

### Algorithm: Expectimax Search
- Same family as Minimax used in chess engines
- Alternates between **MAX nodes** (best move for player) and **CHANCE nodes** (random tile spawns)
- Searches ahead `depth` plies (5–6 recommended)
- Adaptive depth: goes +2 deeper when ≤2 empty cells remain (endgame)

### Board Representation
- Flat 16-element JS array (4×4 grid)
- Move directions: 0=left, 1=right, 2=up, 3=down
- Each move slides + merges tiles, returns `{board, score, moved}`

### Tile Spawn Rules (the "chance" in Expectimax)
- After every swipe, one new tile spawns in a **random empty cell**
- **90% chance → value 2**, **10% chance → value 4**
- Expectimax averages outcomes across sampled spawn positions weighted by these probabilities
- Sampling strategy: prioritise empty cells **adjacent to high-value tiles** (smarter than random sampling)

---

## Heuristic Evaluation Function

Called at leaf nodes of the search tree. Five components:

| Component | Weight | Description |
|---|---|---|
| Snake score | 1.2 | Reward tiles arranged in snake pattern from a corner |
| Empty cells | 30 | More empty = more survival options (most critical) |
| Smoothness | 0.5 | Penalise large value differences between adjacent tiles |
| Monotonicity | 1.5 | Penalise non-ordered rows/cols (want smooth gradients) |
| Merge count | 3.0 | Reward adjacent equal tiles (setup for future merges) |
| Corner bonus | flat | Large reward if max tile is in any corner |

### Snake Pattern (key insight)
Try all 4 rotations of the snake weight matrix, score against the best-matching one. This lets the solver adapt to whichever corner the board naturally gravitates toward, rather than forcing top-left.

```
TL rotation:    TR rotation:
15 14 13 12     12 13 14 15
 8  9 10 11     11 10  9  8
 7  6  5  4      4  5  6  7
 0  1  2  3      3  2  1  0
```

---

## Extension Architecture Plan

### File Structure
```
2048-bot-extension/
  manifest.json     ← permissions + content script declaration
  content.js        ← board reader + move dispatcher
  solver.js         ← Expectimax engine (or inline in content.js)
  worker.js         ← optional: run solver in Web Worker
```

### manifest.json
```json
{
  "manifest_version": 3,
  "name": "2048 Bot",
  "version": "1.0",
  "content_scripts": [
    {
      "matches": ["https://play2048.co/*"],
      "js": ["content.js"]
    }
  ]
}
```

### Step 1 — Read Board from DOM
play2048.co tiles are HTML elements with CSS classes like:
- `tile-2`, `tile-256` → the tile value
- `tile-position-2-3` → column 2, row 3 (1-indexed)

Parse these classes to reconstruct the 4×4 grid as a JS array.

```js
function readBoard() {
  const board = new Array(16).fill(0);
  document.querySelectorAll('.tile').forEach(el => {
    const classes = [...el.classList];
    const valClass = classes.find(c => /^tile-\d+$/.test(c));
    const posClass = classes.find(c => /^tile-position-\d+-\d+$/.test(c));
    if (!valClass || !posClass) return;
    const val = parseInt(valClass.split('-')[1]);
    const [, , col, row] = posClass.split('-').map(Number); // 1-indexed
    board[(row - 1) * 4 + (col - 1)] = val;
  });
  return board;
}
```

### Step 2 — Run Solver
Pass board to Expectimax, get best direction (0–3).

```js
const bestDir = pickMove(board, depth); // returns 0=left,1=right,2=up,3=down
```

For performance, offload to a **Web Worker** so the page doesn't freeze during deep search.

### Step 3 — Send Keypress to Game
The game listens to `keydown` on `document`. Dispatch synthetic events:

```js
const KEY_MAP = { 0: 37, 1: 39, 2: 38, 3: 40 }; // left right up down
function sendMove(dir) {
  document.dispatchEvent(new KeyboardEvent('keydown', {
    keyCode: KEY_MAP[dir],
    bubbles: true
  }));
}
```

### Step 4 — Loop with Timing
```js
async function autoPlay() {
  while (true) {
    const board = readBoard();
    if (isGameOver()) break;
    const dir = pickMove(board, 5);
    sendMove(dir);
    await sleep(200); // wait for CSS animation (~150ms) + buffer
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
```

**Better alternative to fixed delay:** Use `MutationObserver` on the tile container — fires exactly when the DOM updates after each move, no guessing on timing.

```js
const observer = new MutationObserver(() => {
  observer.disconnect();
  setTimeout(nextMove, 50); // small buffer after DOM settles
});
observer.observe(document.querySelector('.tile-container'), { childList: true, subtree: true });
```

### Step 5 — Detect Game Over
Watch for the game-over overlay:
```js
function isGameOver() {
  return document.querySelector('.game-over') !== null;
}
```

---

## Key Implementation Notes

- **No anti-cheat** on play2048.co — synthetic keypresses work fine
- **Move ordering**: try Up and Left first in the solver — these consolidate toward corners
- **Depth 5** = fast (~50ms/move), reliably hits 2048–4096
- **Depth 6** = slower (~200ms/move), regularly hits 8192
- Web Worker is recommended at depth 6+ to avoid UI jank
- The solver code from the in-browser prototype is directly portable — same JS, same logic

---

## Solver Core Functions to Port

These are the critical functions to copy from the prototype into `solver.js`:

1. `doMove(board, dir)` → `{board, score, moved}`
2. `evaluate(board)` → heuristic score (number)
3. `expectimax(board, depth, isMax)` → expected value
4. `pickMove(board, baseDepth)` → best direction (0–3)
5. `adaptDepth(board, base)` → adjusted depth based on empty count
6. `snakeScore(board)` → best-rotation snake heuristic
7. `cornerBonus(board)` → flat bonus for max tile in corner

---

## How to Load Extension in Chrome

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `2048-bot-extension/` folder

No Chrome Web Store submission needed for personal use.
