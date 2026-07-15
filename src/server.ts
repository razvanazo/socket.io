import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import {
  Room,
  Player,
  GamePhase,
  CreateRoomPayload,
  JoinRoomPayload,
  SubmitGuessPayload,
  AttackLogEntry,
  CellResult,
} from './types';

// ─── Constants ────────────────────────────────────────────────────────────────

const PORT = 8081;
const WORD_LENGTH = 4;
const COUNTDOWN_FROM = 10;
const RECONNECT_WINDOW_MS = 30_000;
const SURVIVAL_BONUS = 10;

// ─── App setup ────────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
});

// ─── State ────────────────────────────────────────────────────────────────────

const rooms = new Map<string, Room>();
// socket id → room code
const socketToRoom = new Map<string, string>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

function generateTargetCode(): string {
  return Array.from({ length: WORD_LENGTH }, () =>
    Math.floor(Math.random() * 10).toString()
  ).join('');
}

function logId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function roomSnapshot(room: Room) {
  return {
    code: room.code,
    hostId: room.hostId,
    maxPlayers: room.maxPlayers,
    timeLimitMs: room.timeLimitMs,
    phase: room.phase,
    startedAt: room.startedAt,
    endsAt: room.endsAt,
    attackLog: room.attackLog.slice(-30),
    players: Array.from(room.players.values()).map((p) => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      isReady: p.isReady,
      hasChosenCode: p.hasChosenCode,
      status: p.status,
      score: p.score,
      eliminations: p.eliminations,
      lastEliminationAt: p.lastEliminationAt,
      joinedAt: p.joinedAt,
    })),
  };
}

function broadcastRoom(room: Room) {
  io.to(room.code).emit('room_updated', roomSnapshot(room));
}

function addAttackLog(room: Room, message: string, opts?: { attackerId?: string; victimId?: string }) {
  const entry: AttackLogEntry = {
    id: logId(),
    timestamp: Date.now(),
    message,
    ...opts,
  };
  room.attackLog.push(entry);
  io.to(room.code).emit('attack_log', entry);
}

function evaluateGuess(guess: string, target: string): CellResult[] {
  const result: CellResult[] = Array(WORD_LENGTH).fill(null).map((_, i) => ({
    digit: guess[i],
    status: 'absent' as const,
  }));
  const targetCounts: Record<string, number> = {};

  // First pass: correct positions
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (guess[i] === target[i]) {
      result[i] = { digit: guess[i], status: 'correct' };
    } else {
      targetCounts[target[i]] = (targetCounts[target[i]] || 0) + 1;
    }
  }

  // Second pass: present (wrong position)
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (result[i].status === 'correct') continue;
    if (targetCounts[guess[i]] > 0) {
      result[i] = { digit: guess[i], status: 'present' };
      targetCounts[guess[i]]--;
    }
  }

  return result;
}

function activePlayers(room: Room): Player[] {
  return Array.from(room.players.values()).filter((p) => p.status === 'active');
}

/** Jucători care încă sunt "în joc" – activi sau deconectați (în fereastra de reconectare) */
function inGamePlayers(room: Room): Player[] {
  return Array.from(room.players.values()).filter(
    (p) => p.status === 'active' || p.status === 'disconnected'
  );
}

function endGame(room: Room, reason: 'time' | 'one_left' | 'no_players') {
  if (room.phase === 'finished') return;
  room.phase = 'finished';

  if (room.gameTimeout) clearTimeout(room.gameTimeout as ReturnType<typeof setTimeout>);

  // Survival bonus to remaining active players
  const survivors = activePlayers(room);
  survivors.forEach((p) => {
    p.score += SURVIVAL_BONUS;
  });

  if (survivors.length > 0) {
    const names = survivors.map((p) => p.name).join(', ');
    addAttackLog(room, `${names} a primit bonus de supraviețuire (+${SURVIVAL_BONUS} puncte).`);
  }

  // Build final ranking
  const ranking = Array.from(room.players.values())
    .filter((p) => p.status !== 'left')
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aActive = a.status === 'active' ? 0 : 1;
      const bActive = b.status === 'active' ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      if (b.eliminations !== a.eliminations) return b.eliminations - a.eliminations;
      return (a.lastEliminationAt ?? Infinity) - (b.lastEliminationAt ?? Infinity);
    })
    .map((p, i) => ({
      rank: i + 1,
      id: p.id,
      name: p.name,
      score: p.score,
      eliminations: p.eliminations,
      status: p.status,
    }));

  io.to(room.code).emit('game_ended', {
    reason,
    ranking,
    room: roomSnapshot(room),
  });
}

function startCountdown(room: Room) {
  room.phase = 'countdown';
  broadcastRoom(room);

  let count = COUNTDOWN_FROM;
  io.to(room.code).emit('countdown_tick', { count });

  room.countdownInterval = setInterval(() => {
    count--;
    io.to(room.code).emit('countdown_tick', { count });

    if (count <= 0) {
      clearInterval(room.countdownInterval as ReturnType<typeof setInterval>);
      startGame(room);
    }
  }, 1000);
}

function startGame(room: Room) {
  room.phase = 'playing';
  room.startedAt = Date.now();
  room.endsAt = Date.now() + room.timeLimitMs;

  // Elimină din joc toți jucătorii care nu și-au ales un cod
  Array.from(room.players.values()).forEach((p) => {
    if (!p.hasChosenCode) {
      p.status = 'left';
    }
  });

  broadcastRoom(room);
  io.to(room.code).emit('game_started', { endsAt: room.endsAt });

  room.gameTimeout = setTimeout(() => endGame(room, 'time'), room.timeLimitMs);
}

// ─── Socket handlers ──────────────────────────────────────────────────────────

io.on('connection', (socket: Socket) => {
  console.log(`[+] ${socket.id} connected`);

  // ── Create room ─────────────────────────────────────────────────────────────
  socket.on('create_room', ({ playerName, maxPlayers, timeLimitMs, roomCode: desiredCode }: CreateRoomPayload & { roomCode?: string }, ack) => {
    try {
      // Dacă jucătorul cere un cod specific, îl validăm și îl folosim (dacă e liber)
      let code: string;
      if (desiredCode) {
        const normalized = desiredCode.trim().toUpperCase();
        if (!/^[A-Z0-9]{5}$/.test(normalized)) {
          return ack({ ok: false, error: 'Codul camerei trebuie să aibă exact 5 caractere alfanumerice.' });
        }
        if (rooms.has(normalized)) {
          return ack({ ok: false, error: `Camera cu codul „${normalized}" există deja. Alege alt cod sau lasă gol pentru unul generat automat.` });
        }
        code = normalized;
      } else {
        code = generateRoomCode();
      }

      const host: Player = {
        id: socket.id,
        name: playerName.trim().slice(0, 20) || 'Host',
        isHost: true,
        isReady: false,
        hasChosenCode: false,
        status: 'active',
        score: 0,
        eliminations: 0,
        lastEliminationAt: null,
        joinedAt: Date.now(),
        disconnectedAt: null,
        targetCode: generateTargetCode(),
      };

      const room: Room = {
        code,
        hostId: socket.id,
        maxPlayers: Math.min(Math.max(maxPlayers, 2), 10),
        timeLimitMs,
        phase: 'lobby',
        players: new Map([[socket.id, host]]),
        startedAt: null,
        endsAt: null,
        attackLog: [],
        countdownInterval: null,
        gameTimeout: null,
      };

      rooms.set(code, room);
      socketToRoom.set(socket.id, code);
      socket.join(code);

      console.log(`[room] created ${code} by ${playerName}`);
      ack({ ok: true, room: roomSnapshot(room), playerId: socket.id });
    } catch (e) {
      ack({ ok: false, error: 'Could not create room' });
    }
  });

  // ── Join room ────────────────────────────────────────────────────────────────
  socket.on('join_room', ({ roomCode, playerName }: JoinRoomPayload, ack) => {
    try {
      const code = roomCode.trim().toUpperCase();
      const room = rooms.get(code);

      if (!room) return ack({ ok: false, error: 'Camera nu există.' });
      if (room.phase !== 'lobby') return ack({ ok: false, error: 'Jocul a început deja.' });
      if (room.players.size >= room.maxPlayers) return ack({ ok: false, error: 'Camera este plină.' });

      const player: Player = {
        id: socket.id,
        name: playerName.trim().slice(0, 20) || 'Player',
        isHost: false,
        isReady: false,
        hasChosenCode: false,
        status: 'active',
        score: 0,
        eliminations: 0,
        lastEliminationAt: null,
        joinedAt: Date.now(),
        disconnectedAt: null,
        targetCode: generateTargetCode(),
      };

      room.players.set(socket.id, player);
      socketToRoom.set(socket.id, code);
      socket.join(code);

      console.log(`[room] ${playerName} joined ${code}`);
      ack({ ok: true, room: roomSnapshot(room), playerId: socket.id });
      broadcastRoom(room);
      // Camera plină → nu mai pornește automat, hostul controlează startul
    } catch (e) {
      ack({ ok: false, error: 'Eroare la alăturare.' });
    }
  });

  // ── Set player code ──────────────────────────────────────────────────────────
  socket.on('set_player_code', (
    { roomCode, code }: { roomCode: string; code: string },
    ack: (r: unknown) => void
  ) => {
    const room = rooms.get(roomCode);
    const player = room?.players.get(socket.id);
    if (!room || !player) return ack({ ok: false, error: 'Camera nu există.' });
    if (room.phase !== 'lobby') return ack({ ok: false, error: 'Jocul a început deja.' });
    if (!/^\d{4}$/.test(code)) return ack({ ok: false, error: 'Codul trebuie să aibă exact 4 cifre.' });
    player.targetCode = code;
    player.hasChosenCode = true;
    ack({ ok: true });
  });

  // ── Set ready ────────────────────────────────────────────────────────────────
  socket.on('set_ready', ({ roomCode, isReady }: { roomCode: string; isReady: boolean }) => {
    const room = rooms.get(roomCode);
    const player = room?.players.get(socket.id);
    if (!room || !player || room.phase !== 'lobby') return;

    player.isReady = isReady;
    broadcastRoom(room);
  });

  // ── Start game (host only) ───────────────────────────────────────────────────
  socket.on('start_game', ({ roomCode }: { roomCode: string }, ack?: (r: unknown) => void) => {
    const room = rooms.get(roomCode);
    if (!room) return ack?.({ ok: false, error: 'Camera nu există.' });
    if (room.hostId !== socket.id) return ack?.({ ok: false, error: 'Nu ești host.' });
    if (room.phase !== 'lobby') return ack?.({ ok: false, error: 'Jocul nu poate fi pornit acum.' });
    if (room.players.size < 2) return ack?.({ ok: false, error: 'Sunt necesari cel puțin 2 jucători.' });

    // Validare: hostul trebuie să fi ales un cod
    const host = room.players.get(socket.id);
    if (!host?.hasChosenCode) {
      return ack?.({ ok: false, error: 'Trebuie să-ți alegi mai întâi propriul cod (apasă "Alege codul tău").' });
    }

    // Validare: cel puțin 1 jucător (non-host) trebuie să fie ready
    const readyNonHost = Array.from(room.players.values()).filter(
      (p) => p.id !== socket.id && p.isReady
    );
    if (readyNonHost.length === 0) {
      return ack?.({ ok: false, error: 'Cel puțin un alt jucător trebuie să fie pregătit.' });
    }

    startCountdown(room);
    ack?.({ ok: true });
  });

  // ── Submit guess ─────────────────────────────────────────────────────────────
  socket.on('submit_guess', ({ roomCode, targetPlayerId, guess }: SubmitGuessPayload, ack) => {
    try {
      const room = rooms.get(roomCode);
      if (!room || room.phase !== 'playing') return ack({ ok: false, error: 'Jocul nu este activ.' });

      const attacker = room.players.get(socket.id);
      const target = room.players.get(targetPlayerId);

      if (!attacker || attacker.status !== 'active') return ack({ ok: false, error: 'Nu poți ataca.' });
      if (!target || target.status !== 'active') return ack({ ok: false, error: 'Ținta nu mai este activă.' });
      if (socket.id === targetPlayerId) return ack({ ok: false, error: 'Nu te poți ataca pe tine.' });
      if (guess.length !== WORD_LENGTH || !/^\d+$/.test(guess)) return ack({ ok: false, error: 'Ghicire invalidă.' });

      const result = evaluateGuess(guess, target.targetCode);
      const isCorrect = result.every((c) => c.status === 'correct');

      ack({ ok: true, result, isCorrect });

      if (isCorrect) {
        // Elimination
        const pointsGained = target.score + 1;
        attacker.score += pointsGained;
        attacker.eliminations += 1;
        attacker.lastEliminationAt = Date.now();
        target.status = 'eliminated';

        // Assign new target code to attacker (so next target is different)
        // (optional: only matters if they re-attack; target is already eliminated)

        addAttackLog(
          room,
          `${attacker.name} l-a eliminat pe ${target.name} (+${pointsGained} puncte).`,
          { attackerId: attacker.id, victimId: target.id }
        );

        io.to(room.code).emit('player_eliminated', {
          eliminatedId: target.id,
          eliminatedName: target.name,
          attackerId: attacker.id,
          attackerName: attacker.name,
          pointsGained,
          room: roomSnapshot(room),
        });

        // Check if only one (or zero) active players remain
        const remaining = activePlayers(room);
        if (remaining.length <= 1) {
          endGame(room, remaining.length === 0 ? 'no_players' : 'one_left');
        }
      }

      broadcastRoom(room);
    } catch (e) {
      ack({ ok: false, error: 'Eroare server.' });
    }
  });

  // ── Get current room state ───────────────────────────────────────────────────
  socket.on('get_room', ({ roomCode }: { roomCode: string }, ack: (r: unknown) => void) => {
    const room = rooms.get(roomCode);
    if (!room) return ack({ ok: false, error: 'Camera nu există.' });
    ack({ ok: true, room: roomSnapshot(room) });
  });

  // ── Reset room (play again) ──────────────────────────────────────────────────
  socket.on('reset_room', ({ roomCode }: { roomCode: string }, ack: (r: unknown) => void) => {
    const room = rooms.get(roomCode);
    if (!room) return ack({ ok: false, error: 'Camera nu există.' });
    if (room.hostId !== socket.id) return ack({ ok: false, error: 'Nu ești host.' });

    // Oprește timers activi
    if (room.countdownInterval) clearInterval(room.countdownInterval as ReturnType<typeof setInterval>);
    if (room.gameTimeout) clearTimeout(room.gameTimeout as ReturnType<typeof setTimeout>);

    // Resetează starea camerei
    room.phase = 'lobby';
    room.startedAt = null;
    room.endsAt = null;
    room.attackLog = [];
    room.countdownInterval = null;
    room.gameTimeout = null;

    // Resetează toți jucătorii conectați (excluzi pe cei cu status 'left' care nu au socket activ)
    Array.from(room.players.values()).forEach((p) => {
      p.status = 'active';
      p.isReady = false;
      p.hasChosenCode = false;
      p.score = 0;
      p.eliminations = 0;
      p.lastEliminationAt = null;
      p.disconnectedAt = null;
      p.targetCode = generateTargetCode();
    });

    broadcastRoom(room);
    ack({ ok: true, room: roomSnapshot(room) });
  });

  // ── Get target info (so attacker knows number of digits, not the actual code) ─
  socket.on('get_target_info', ({ roomCode, targetPlayerId }: { roomCode: string; targetPlayerId: string }, ack) => {
    const room = rooms.get(roomCode);
    const target = room?.players.get(targetPlayerId);
    if (!target) return ack({ ok: false });
    ack({ ok: true, codeLength: target.targetCode.length });
  });

  // ── Remove player (host only) ────────────────────────────────────────────────
  socket.on('remove_player', ({ roomCode, playerId }: { roomCode: string; playerId: string }, ack?: (r: unknown) => void) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id || room.phase !== 'lobby') return;

    const player = room.players.get(playerId);
    if (!player || player.isHost) return;

    room.players.delete(playerId);
    socketToRoom.delete(playerId);

    const targetSocket = io.sockets.sockets.get(playerId);
    targetSocket?.leave(roomCode);
    targetSocket?.emit('kicked', { roomCode });

    broadcastRoom(room);
    ack?.({ ok: true });
  });

  // ── Cancel room (host only) ──────────────────────────────────────────────────
  socket.on('cancel_room', ({ roomCode }: { roomCode: string }) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id) return;

    io.to(roomCode).emit('room_cancelled');
    io.socketsLeave(roomCode);
    rooms.delete(roomCode);
  });

  // ── Leave room ───────────────────────────────────────────────────────────────
  socket.on('leave_room', ({ roomCode }: { roomCode: string }) => {
    handleLeave(socket, roomCode, 'voluntary');
  });

  // ── Disconnect ───────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id} disconnected`);
    const roomCode = socketToRoom.get(socket.id);
    if (roomCode) handleLeave(socket, roomCode, 'disconnect');
  });
});

// ─── Leave / Disconnect logic ─────────────────────────────────────────────────

function handleLeave(socket: Socket, roomCode: string, reason: 'voluntary' | 'disconnect') {
  const room = rooms.get(roomCode);
  if (!room) return;

  const player = room.players.get(socket.id);
  if (!player) return;

  socketToRoom.delete(socket.id);

  if (room.phase === 'lobby') {
    room.players.delete(socket.id);
    socket.leave(roomCode);

    if (room.players.size === 0) {
      rooms.delete(roomCode);
      return;
    }

    // Transfer host if needed
    if (room.hostId === socket.id) {
      const next = Array.from(room.players.values())[0];
      next.isHost = true;
      room.hostId = next.id;
    }

    broadcastRoom(room);
  } else if (room.phase === 'playing' || room.phase === 'countdown') {
    if (reason === 'disconnect') {
      player.status = 'disconnected';
      player.disconnectedAt = Date.now();

      addAttackLog(room, `${player.name} s-a deconectat.`);
      broadcastRoom(room);

      // Dacă nu mai sunt deloc jucători în joc (nici activi, nici deconectați), terminăm imediat
      if (room.phase === 'playing' && inGamePlayers(room).length === 0) {
        endGame(room, 'no_players');
        return;
      }

      // Reconnect window
      setTimeout(() => {
        const currentPlayer = room.players.get(socket.id);
        if (currentPlayer && currentPlayer.status === 'disconnected') {
          currentPlayer.status = 'left';
          addAttackLog(room, `${player.name} a ieșit din joc.`);
          broadcastRoom(room);

          // Check win condition
          if (room.phase === 'playing' && activePlayers(room).length <= 1) {
            endGame(room, activePlayers(room).length === 0 ? 'no_players' : 'one_left');
          }
        }
      }, RECONNECT_WINDOW_MS);
    } else {
      player.status = 'left';
      socket.leave(roomCode);
      addAttackLog(room, `${player.name} a ieșit din joc.`);
      broadcastRoom(room);

      // Transfer host if needed
      if (room.hostId === socket.id) {
        const next = Array.from(room.players.values()).find((p) => p.status === 'active');
        if (next) {
          next.isHost = true;
          room.hostId = next.id;
        }
      }

      if (room.phase === 'playing' && activePlayers(room).length <= 1) {
        endGame(room, activePlayers(room).length === 0 ? 'no_players' : 'one_left');
      }
    }
  }
}

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`🚀 Neon Lock backend running on port ${PORT}`);
});
