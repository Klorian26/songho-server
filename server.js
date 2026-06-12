// server.js — Backend multijoueur Songho (Node.js + Express)
const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // sert les fichiers HTML/CSS/JS

// ── Stockage en mémoire ──────────────────────────────────────
const games = {};

// ── Routes ───────────────────────────────────────────────────
app.post('/api', (req, res) => {
  const action = req.query.action || req.body.action || '';
  try {
    switch (action) {
      case 'create': return res.json(actionCreate(req.body));
      case 'join':   return res.json(actionJoin(req.body));
      case 'poll':   return res.json(actionPoll(req.body));
      case 'move':   return res.json(actionMove(req.body));
      case 'chat':   return res.json(actionChat(req.body));
      case 'ping':   return res.json(actionPing(req.body));
      case 'list':   return res.json(actionList());
      default:       return res.json({ ok: false, error: 'Action inconnue : ' + action });
    }
  } catch (e) {
    return res.json({ ok: false, error: e.message });
  }
});

app.get('/health', (_, res) => res.json({ ok: true, games: Object.keys(games).length }));

app.listen(PORT, () => console.log(`Songho server running on port ${PORT}`));

// ══════════════════════════════════════════════════════════════
// ACTIONS
// ══════════════════════════════════════════════════════════════

function actionCreate(body) {
  const gameId = crypto.randomBytes(3).toString('hex').toUpperCase();
  const token  = crypto.randomBytes(16).toString('hex');
  const name   = (body.name || 'Sud').trim();

  games[gameId] = {
    id: gameId,
    status: 'waiting',
    players: {
      south: { token, name, ping: Date.now() },
      north: null
    },
    board: { north: [5,5,5,5,5,5,5], south: [5,5,5,5,5,5,5] },
    scores: { north: 0, south: 0 },
    currentPlayer: 'south',
    moveNumber: 0,
    gameStatus: 'playing',
    winner: null,
    lastMove: null,
    chat: [],
    created: Date.now()
  };

  return { ok: true, gameId, token, side: 'south' };
}

function actionJoin(body) {
  const gameId = (body.gameId || '').toUpperCase().trim();
  const game   = getGame(gameId);
  const name   = (body.name || 'Nord').trim();

  if (game.status !== 'waiting') throw new Error('Cette partie n\'est plus disponible.');
  if (game.players.north)        throw new Error('La partie est déjà complète.');

  const token = crypto.randomBytes(16).toString('hex');
  game.players.north = { token, name, ping: Date.now() };
  game.status = 'playing';
  game.chat.push(sysMsg(`La partie commence ! ${game.players.south.name} (Sud) vs ${name} (Nord).`));

  return { ok: true, gameId, token, side: 'north' };
}

function actionPoll(body) {
  const gameId   = (body.gameId || '').toUpperCase().trim();
  const token    = body.token || '';
  const lastChat = parseInt(body.lastChat) || 0;
  const game     = getGame(gameId);
  const side     = sideFromToken(game, token);

  if (side) game.players[side].ping = Date.now();

  const newMessages = game.chat.slice(lastChat);
  return {
    ok: true,
    state: publicState(game, side),
    chat: newMessages,
    chatTotal: game.chat.length
  };
}

function actionMove(body) {
  const gameId   = (body.gameId || '').toUpperCase().trim();
  const token    = body.token || '';
  const pitIndex = parseInt(body.pitIndex);
  const game     = getGame(gameId);
  const side     = sideFromToken(game, token);

  if (!side)                        throw new Error('Token invalide.');
  if (game.status !== 'playing')    throw new Error('La partie n\'est pas en cours.');
  if (game.gameStatus !== 'playing') throw new Error('La partie est terminée.');
  if (game.currentPlayer !== side)  throw new Error('Ce n\'est pas votre tour.');
  if (pitIndex < 0 || pitIndex > 6) throw new Error('Case invalide.');

  const result = applyMoveEngine(game, side, pitIndex);
  if (!result.ok) throw new Error(result.error);

  game.lastMove = { player: side, pitIndex, moveNumber: game.moveNumber };

  if (game.gameStatus === 'ended') {
    game.status = 'ended';
    const w = game.winner;
    const wname = w === 'draw' ? null : game.players[w]?.name;
    const msg = w === 'draw'
      ? `Égalité ! ${game.scores.north} – ${game.scores.south}`
      : `${wname} gagne ! ${game.scores.north} – ${game.scores.south}`;
    game.chat.push(sysMsg('🏆 ' + msg));
  }

  return { ok: true, state: publicState(game, side) };
}

function actionChat(body) {
  const gameId = (body.gameId || '').toUpperCase().trim();
  const token  = body.token || '';
  let text     = (body.text || '').trim();

  if (!text) throw new Error('Message vide.');
  if (text.length > 200) text = text.substring(0, 200);

  const game = getGame(gameId);
  const side = sideFromToken(game, token);
  if (!side) throw new Error('Token invalide.');

  game.chat.push({
    ts: Date.now(), side,
    name: game.players[side].name,
    text: text.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    sys: false
  });
  if (game.chat.length > 100) game.chat = game.chat.slice(-100);

  return { ok: true, chatCount: game.chat.length };
}

function actionPing(body) {
  const gameId = (body.gameId || '').toUpperCase().trim();
  const token  = body.token || '';
  const game   = getGame(gameId);
  const side   = sideFromToken(game, token);
  if (side) game.players[side].ping = Date.now();
  return { ok: true };
}

function actionList() {
  const waiting = Object.values(games)
    .filter(g => g.status === 'waiting')
    .map(g => ({
      gameId: g.id,
      name: g.players.south.name,
      created: g.created
    }));
  return { ok: true, games: waiting };
}

// ══════════════════════════════════════════════════════════════
// MOTEUR DE JEU
// ══════════════════════════════════════════════════════════════

const CYCLE = [
  {player:'north',pit:0},{player:'north',pit:1},{player:'north',pit:2},
  {player:'north',pit:3},{player:'north',pit:4},{player:'north',pit:5},
  {player:'north',pit:6},{player:'south',pit:6},{player:'south',pit:5},
  {player:'south',pit:4},{player:'south',pit:3},{player:'south',pit:2},
  {player:'south',pit:1},{player:'south',pit:0}
];

function otherP(p) { return p === 'north' ? 'south' : 'north'; }
function atkIdx(p) { return p === 'north' ? 6 : 0; }
function oppPath(p) {
  const opp = otherP(p);
  const idx = p === 'north' ? [6,5,4,3,2,1,0] : [0,1,2,3,4,5,6];
  return idx.map(i => ({ player: opp, pit: i }));
}
function oppFirst(p) {
  return p === 'north' ? {player:'south',pit:6} : {player:'north',pit:0};
}
function cycleIdx(p, pit) { return CYCLE.findIndex(x => x.player===p && x.pit===pit); }
function bsum(arr) { return arr.reduce((a,b)=>a+b,0); }
function clone(g) { return JSON.parse(JSON.stringify(g)); }

function sowSeeds(game, player, pitIndex) {
  const seeds = game.board[player][pitIndex];
  if (seeds <= 0) return { ok: false, error: 'Case vide' };

  game.board[player][pitIndex] = 0;
  const visited = [];
  const start   = cycleIdx(player, pitIndex);
  const n       = CYCLE.length;

  if (seeds <= 13) {
    for (let i = 1; i <= seeds; i++) {
      const pos = CYCLE[(start + i) % n];
      game.board[pos.player][pos.pit]++;
      visited.push(pos);
    }
  } else {
    let remaining = seeds;
    for (let i = 1; i <= 13; i++) {
      const pos = CYCLE[(start + i) % n];
      game.board[pos.player][pos.pit]++;
      visited.push(pos);
      remaining--;
    }
    const path  = oppPath(player);
    const first = oppFirst(player);
    for (let i = 0; i < remaining; i++) {
      const pos    = path[i % path.length];
      const isLast = i === remaining - 1;
      const isProt = pos.player === first.player && pos.pit === first.pit;
      if (isLast && isProt) {
        game.scores[player]++;
        visited.push(pos);
        continue;
      }
      game.board[pos.player][pos.pit]++;
      visited.push(pos);
    }
  }
  return { ok: true, visited, lastPos: visited[visited.length - 1] };
}

function isCapVal(n) { return n === 2 || n === 3 || n === 4; }

function resolveCaptures(game, player, lastPos) {
  const opp = otherP(player);
  if (lastPos.player !== opp) return 0;
  const first = oppFirst(player);
  if (lastPos.player === first.player && lastPos.pit === first.pit) return 0;

  const val = game.board[lastPos.player][lastPos.pit];
  if (!isCapVal(val)) return 0;

  const path    = oppPath(player);
  const lastIdx = path.findIndex(p => p.player === lastPos.player && p.pit === lastPos.pit);
  if (lastIdx <= 0) return 0;

  const chain = [];
  for (let i = lastIdx; i >= 0; i--) {
    const pos = path[i];
    const cnt = game.board[pos.player][pos.pit];
    if (!isCapVal(cnt)) break;
    chain.push({ player: pos.player, pit: pos.pit, seeds: cnt });
  }
  if (!chain.length) return 0;

  const rem = [...game.board[opp]];
  for (const c of chain) rem[c.pit] -= c.seeds;
  if (bsum(rem) === 0) return 0;

  let total = 0;
  for (const c of chain) {
    game.board[c.player][c.pit] -= c.seeds;
    total += c.seeds;
  }
  game.scores[player] += total;
  return total;
}

function getLegalMoves(game) {
  const player = game.currentPlayer;
  const opp    = otherP(player);
  const atk    = atkIdx(player);
  const oppEmpty = bsum(game.board[opp]) === 0;

  const nonEmpty = [];
  for (let i = 0; i < 7; i++)
    if (game.board[player][i] > 0) nonEmpty.push(i);

  const moves = [];
  for (const pit of nonEmpty) {
    if (pit === atk) {
      const seeds = game.board[player][pit];
      if (seeds === 1) continue;
      if (seeds === 2) {
        const sim = clone(game);
        const sr  = sowSeeds(sim, player, pit);
        if (!sr.ok) continue;
        resolveCaptures(sim, player, sr.lastPos);
        if (sim.scores[player] <= game.scores[player]) continue;
      }
    }
    moves.push(pit);
  }

  if (!moves.length) return [];

  if (oppEmpty) {
    const delivered = {};
    for (const pit of moves) {
      const sim    = clone(game);
      const before = bsum(sim.board[opp]);
      sowSeeds(sim, player, pit);
      delivered[pit] = bsum(sim.board[opp]) - before;
    }
    const g7 = moves.filter(p => delivered[p] >= 7);
    if (g7.length) return g7;
    const pos = moves.filter(p => delivered[p] > 0);
    if (pos.length) {
      const mx = Math.max(...pos.map(p => delivered[p]));
      return pos.filter(p => delivered[p] === mx);
    }
    return game.board[player][atk] && [1,2].includes(game.board[player][atk]) ? [atk] : [];
  }

  return moves;
}

function applyMoveEngine(game, player, pitIndex) {
  const legal = getLegalMoves(game);
  if (!legal.includes(pitIndex)) return { ok: false, error: 'Coup interdit.' };

  const sr = sowSeeds(game, player, pitIndex);
  if (!sr.ok) return { ok: false, error: sr.error };

  resolveCaptures(game, player, sr.lastPos);
  game.moveNumber++;

  if (game.scores.north >= 40 || game.scores.south >= 40) {
    game.gameStatus = 'ended';
    game.winner = game.scores.north >= 40 ? 'north' : 'south';
  } else if (bsum(game.board.north) + bsum(game.board.south) < 10) {
    game.scores.north += bsum(game.board.north);
    game.scores.south += bsum(game.board.south);
    game.board.north = [0,0,0,0,0,0,0];
    game.board.south = [0,0,0,0,0,0,0];
    game.gameStatus = 'ended';
    const n = game.scores.north, s = game.scores.south;
    game.winner = n > s ? 'north' : s > n ? 'south' : 'draw';
  } else {
    game.currentPlayer = otherP(player);
    if (!getLegalMoves(game).length) {
      game.scores.north += bsum(game.board.north);
      game.scores.south += bsum(game.board.south);
      game.board.north = [0,0,0,0,0,0,0];
      game.board.south = [0,0,0,0,0,0,0];
      game.gameStatus = 'ended';
      const n = game.scores.north, s = game.scores.south;
      game.winner = n > s ? 'north' : s > n ? 'south' : 'draw';
    }
  }

  return { ok: true, game };
}

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

function publicState(game, mySide) {
  const now = Date.now();
  return {
    gameId:        game.id,
    status:        game.status,
    gameStatus:    game.gameStatus,
    board:         game.board,
    scores:        game.scores,
    currentPlayer: game.currentPlayer,
    moveNumber:    game.moveNumber,
    winner:        game.winner,
    lastMove:      game.lastMove,
    mySide,
    players: {
      north: game.players.north ? { name: game.players.north.name, connected: (now - game.players.north.ping) < 8000 } : null,
      south: { name: game.players.south.name, connected: (now - game.players.south.ping) < 8000 }
    },
    legalMoves: mySide && game.currentPlayer === mySide && game.gameStatus === 'playing'
      ? getLegalMoves(game) : []
  };
}

function getGame(gameId) {
  if (!games[gameId]) throw new Error('Partie introuvable : ' + gameId);
  return games[gameId];
}

function sideFromToken(game, token) {
  for (const side of ['north', 'south'])
    if (game.players[side] && game.players[side].token === token) return side;
  return null;
}

function sysMsg(text) {
  return { ts: Date.now(), side: null, name: 'Système', text, sys: true };
}

// Nettoyage des vieilles parties toutes les heures
setInterval(() => {
  const limit = Date.now() - 24 * 60 * 60 * 1000;
  for (const id of Object.keys(games))
    if (games[id].created < limit) delete games[id];
}, 60 * 60 * 1000);
