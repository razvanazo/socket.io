import { Socket } from 'socket.io';
import { Room, Player, CreateRoomPayload, JoinRoomPayload, SubmitGuessPayload } from './types';
import { GameEngine } from './engine';
import { persistRoom } from './redis';
import { roomSnapshot, generateRoomCode, generateTargetCode, evaluateGuess, activePlayers } from './helpers';
import { WORD_LENGTH } from './constants';

// ─── registerHandlers ─────────────────────────────────────────────────────────
//
// Înregistrează toți listenerii socket.io pentru o conexiune nouă.
// Primește engine-ul și referințele la maps pentru a nu folosi variabile globale.

export function registerHandlers(
  socket: Socket,
  engine: GameEngine,
): void {
  const { rooms, socketToRoom } = engine;

  // ── Create room ─────────────────────────────────────────────────────────────
  socket.on(
    'create_room',
    (
      { playerName, maxPlayers, timeLimitMs, roomCode: desiredCode }: CreateRoomPayload & { roomCode?: string },
      ack: (r: unknown) => void,
    ) => {
      try {
        let code: string;
        if (desiredCode) {
          const normalized = desiredCode.trim().toUpperCase();
          if (!/^[A-Z0-9]{5}$/.test(normalized)) {
            return ack({ ok: false, error: 'Codul camerei trebuie să aibă exact 5 caractere alfanumerice.' });
          }
          if (rooms.has(normalized)) {
            return ack({ ok: false, error: `Camera „${normalized}" există deja. Alege alt cod.` });
          }
          code = normalized;
        } else {
          code = generateRoomCode(rooms);
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

        console.log(`[room] creat ${code} de ${playerName}`);
        ack({ ok: true, room: roomSnapshot(room), playerId: socket.id });
        engine.broadcastRoom(room);
      } catch {
        ack({ ok: false, error: 'Nu s-a putut crea camera.' });
      }
    },
  );

  // ── Rejoin room (reconectare după drop de socket) ────────────────────────────
  socket.on(
    'rejoin_room',
    (
      { roomCode, oldPlayerId }: { roomCode: string; oldPlayerId: string },
      ack: (r: unknown) => void,
    ) => {
      const room = rooms.get(roomCode);
      if (!room) return ack({ ok: false, error: 'Camera nu există.' });
      if (room.phase !== 'playing' && room.phase !== 'countdown') {
        return ack({ ok: false, error: 'Jocul nu este activ.' });
      }

      const player = room.players.get(oldPlayerId);
      if (!player || player.status !== 'disconnected') {
        return ack({ ok: false, error: 'Jucătorul nu poate fi reconectat.' });
      }

      room.players.delete(oldPlayerId);
      socketToRoom.delete(oldPlayerId);

      player.id = socket.id;
      player.status = 'active';
      player.disconnectedAt = null;

      room.players.set(socket.id, player);
      socketToRoom.set(socket.id, roomCode);

      if (room.hostId === oldPlayerId) room.hostId = socket.id;

      socket.join(roomCode);

      console.log(`[room] ${player.name} reconectat în ${roomCode} (${oldPlayerId} → ${socket.id})`);
      engine.broadcastRoom(room);
      ack({ ok: true, room: roomSnapshot(room), newPlayerId: socket.id });
    },
  );

  // ── Join room ────────────────────────────────────────────────────────────────
  socket.on('join_room', ({ roomCode, playerName }: JoinRoomPayload, ack: (r: unknown) => void) => {
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

      console.log(`[room] ${playerName} a intrat în ${code}`);
      ack({ ok: true, room: roomSnapshot(room), playerId: socket.id });
      engine.broadcastRoom(room);
    } catch {
      ack({ ok: false, error: 'Eroare la alăturare.' });
    }
  });

  // ── Set player code ──────────────────────────────────────────────────────────
  socket.on(
    'set_player_code',
    ({ roomCode, code }: { roomCode: string; code: string }, ack: (r: unknown) => void) => {
      const room = rooms.get(roomCode);
      const player = room?.players.get(socket.id);
      if (!room || !player) return ack({ ok: false, error: 'Camera nu există.' });
      if (room.phase !== 'lobby') return ack({ ok: false, error: 'Jocul a început deja.' });
      if (!/^\d{4}$/.test(code)) return ack({ ok: false, error: 'Codul trebuie să aibă exact 4 cifre.' });

      player.targetCode = code;
      player.hasChosenCode = true;
      persistRoom(room).catch(console.error);
      ack({ ok: true });
    },
  );

  // ── Set ready ────────────────────────────────────────────────────────────────
  socket.on('set_ready', ({ roomCode, isReady }: { roomCode: string; isReady: boolean }) => {
    const room = rooms.get(roomCode);
    const player = room?.players.get(socket.id);
    if (!room || !player || room.phase !== 'lobby') return;

    player.isReady = isReady;
    engine.broadcastRoom(room);
  });

  // ── Start game (host only) ───────────────────────────────────────────────────
  socket.on('start_game', ({ roomCode }: { roomCode: string }, ack?: (r: unknown) => void) => {
    const room = rooms.get(roomCode);
    if (!room) return ack?.({ ok: false, error: 'Camera nu există.' });
    if (room.hostId !== socket.id) return ack?.({ ok: false, error: 'Nu ești host.' });
    if (room.phase !== 'lobby') return ack?.({ ok: false, error: 'Jocul nu poate fi pornit acum.' });
    if (room.players.size < 2) return ack?.({ ok: false, error: 'Sunt necesari cel puțin 2 jucători.' });

    const host = room.players.get(socket.id);
    if (!host?.hasChosenCode) {
      return ack?.({ ok: false, error: 'Trebuie să-ți alegi mai întâi propriul cod.' });
    }

    const readyNonHost = Array.from(room.players.values()).filter(
      (p) => p.id !== socket.id && p.isReady,
    );
    if (readyNonHost.length === 0) {
      return ack?.({ ok: false, error: 'Cel puțin un alt jucător trebuie să fie pregătit.' });
    }

    engine.startCountdown(room);
    ack?.({ ok: true });
  });

  // ── Submit guess ─────────────────────────────────────────────────────────────
  socket.on('submit_guess', ({ roomCode, targetPlayerId, guess }: SubmitGuessPayload, ack: (r: unknown) => void) => {
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
        const pointsGained = target.score + 1;
        attacker.score += pointsGained;
        attacker.eliminations += 1;
        attacker.lastEliminationAt = Date.now();
        target.status = 'eliminated';

        engine.addAttackLog(
          room,
          `${attacker.name} l-a eliminat pe ${target.name} (+${pointsGained} pct).`,
          { attackerId: attacker.id, victimId: target.id },
        );

        engine.emitToRoom(room.code, 'player_eliminated', {
          eliminatedId: target.id,
          eliminatedName: target.name,
          attackerId: attacker.id,
          attackerName: attacker.name,
          pointsGained,
          room: roomSnapshot(room),
        });

        const remaining = activePlayers(room);
        if (remaining.length <= 1) {
          engine.endGame(room, remaining.length === 0 ? 'no_players' : 'one_left');
        }
      }

      engine.broadcastRoom(room);
    } catch {
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

    if (room.countdownInterval) clearInterval(room.countdownInterval as ReturnType<typeof setInterval>);
    if (room.gameTimeout) clearTimeout(room.gameTimeout as ReturnType<typeof setTimeout>);

    room.phase = 'lobby';
    room.startedAt = null;
    room.endsAt = null;
    room.attackLog = [];
    room.countdownInterval = null;
    room.gameTimeout = null;

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

    engine.broadcastRoom(room);
    ack({ ok: true, room: roomSnapshot(room) });
  });

  // ── Get target info ──────────────────────────────────────────────────────────
  socket.on(
    'get_target_info',
    ({ roomCode, targetPlayerId }: { roomCode: string; targetPlayerId: string }, ack: (r: unknown) => void) => {
      const room = rooms.get(roomCode);
      const target = room?.players.get(targetPlayerId);
      if (!target) return ack({ ok: false });
      ack({ ok: true, codeLength: target.targetCode.length });
    },
  );

  // ── Remove player (host only, lobby) ────────────────────────────────────────
  socket.on(
    'remove_player',
    ({ roomCode, playerId }: { roomCode: string; playerId: string }, ack?: (r: unknown) => void) => {
      const room = rooms.get(roomCode);
      if (!room || room.hostId !== socket.id || room.phase !== 'lobby') return;

      const player = room.players.get(playerId);
      if (!player || player.isHost) return;

      room.players.delete(playerId);
      socketToRoom.delete(playerId);

      const target = engine.getSocket(playerId);
      target?.leave(roomCode);
      target?.emit('kicked', { roomCode });

      engine.broadcastRoom(room);
      ack?.({ ok: true });
    },
  );

  // ── Cancel room (host only) ──────────────────────────────────────────────────
  socket.on('cancel_room', ({ roomCode }: { roomCode: string }) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id) return;

    engine.emitToRoom(roomCode, 'room_cancelled', {});
    engine.socketsLeave(roomCode);
    engine.deleteRoom(roomCode);
  });

  // ── Leave room ───────────────────────────────────────────────────────────────
  socket.on('leave_room', ({ roomCode }: { roomCode: string }) => {
    engine.handleLeave(socket, roomCode, 'voluntary');
  });

  // ── Disconnect ───────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id} deconectat`);
    const roomCode = socketToRoom.get(socket.id);
    if (roomCode) engine.handleLeave(socket, roomCode, 'disconnect');
  });
}
