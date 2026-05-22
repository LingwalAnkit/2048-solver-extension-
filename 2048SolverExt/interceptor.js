'use strict';

// ══════════════════════════════════════════════════════════════════════
//  INTERCEPTOR v3 — runs in PAGE WORLD before game's Worker is created
//
//  Intercepts both incoming messages (Worker -> main thread)
//  and outgoing messages (main thread -> Worker).
//  Extracts events, calls, responses, and attempts to reconstruct the board.
// ══════════════════════════════════════════════════════════════════════

(function () {
  if (window.__2048InterceptorReady) {
    console.log('[2048-Interceptor] Already installed.');
    return;
  }
  window.__2048InterceptorReady = true;

  // ── Shared state ────────────────────────────────────────────────────
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

  // ── Tile-map → flat board ───────────────────────────────────────────
  function rebuildBoard() {
    const board = new Array(16).fill(0);
    let ok = false;
    for (const t of Object.values(S.tiles)) {
      const x = t.x ?? t.col ?? t.column;
      const y = t.y ?? t.row;
      if (x >= 0 && x < 4 && y >= 0 && y < 4 && t.value > 0) {
        board[y * 4 + x] = t.value;
        ok = true;
      }
    }
    if (ok) {
      S.board      = board;
      S.lastUpdate = Date.now();
    }
  }

  // ── Extract position helper ─────────────────────────────────────────
  function getXY(pos) {
    if (!pos) return null;
    const x = pos.x ?? pos.col ?? pos.column ?? pos[0];
    const y = pos.y ?? pos.row           ?? pos[1];
    return (x != null && y != null) ? { x, y } : null;
  }

  // ── Try to parse a tile object ──────────────────────────────────────
  function parseTile(t) {
    if (!t || typeof t !== 'object') return null;
    const id  = t.id   ?? t.tileId ?? t.name ?? null;
    const val = t.value ?? t.val   ?? t.v    ?? 0;
    const xy  = getXY(t.position ?? t.pos ?? t.cell ?? t);
    if (!xy || !val) return null;
    return { id, x: xy.x, y: xy.y, value: val };
  }

  // ── Process an event payload (incoming or outgoing) ─────────────────
  function processEvent(eventName, data) {
    if (!data) return;

    // ── Score ──────────────────────────────────────────────────────
    if (typeof data === 'object') {
      for (const key of ['score', 'points', 'currentScore']) {
        if (typeof data[key] === 'number') { S.score = data[key]; break; }
      }
    }

    // ── Full board init (game start / reset) ───────────────────────
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

    // ── Differential move update ───────────────────────────────────
    if (typeof data !== 'object') return;

    let changed = false;

    // Pattern A: data.moves
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

    // Pattern B: data.mergedTiles / data.merges
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

    // Pattern C: data.newTile / data.spawned
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

    // Pattern D: the whole message IS a tile change array
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

  // ── Handle incoming messages (Worker -> main thread) ────────────────
  function processIncomingMessage(raw) {
    S.msgCount++;
    S.incomingCount++;
    S.lastIncoming.push(raw);
    if (S.lastIncoming.length > 50) S.lastIncoming.shift();

    if (!raw || typeof raw !== 'object') return;

    const type = raw.type || 'unknown';
    S.incomingTypes[type] = (S.incomingTypes[type] || 0) + 1;

    if (type === 'event' && raw.event) {
      const eventName = raw.event;
      S.eventNames[eventName] = (S.eventNames[eventName] || 0) + 1;
      try {
        S.eventSamples[eventName] = JSON.parse(JSON.stringify(raw.data));
      } catch (_) {
        S.eventSamples[eventName] = raw.data;
      }
      processEvent(eventName, raw.data);
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

  // ── Handle outgoing messages (main thread -> Worker) ────────────────
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
          // If the update call sends updates to the worker, check its arguments
          processEvent('__outgoing_update__', raw.args[0]);
        }
      }
    }
  }

  // ── Patch Worker ────────────────────────────────────────────────────
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
