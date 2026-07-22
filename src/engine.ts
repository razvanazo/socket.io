import { Server, Socket } from 'socket.io';
import { Room, Player, AttackLogEntry } from './types';
import { persistRoom, deletePersistedRoom } from './redis';
import {
  roomSnapshot,
  activePlayers,
  inGamePlayers,
  logId,
  generateTargetCode,
} from './helpers';
import {
  SURVIVAL_BONUS,
  RECONNECT_WINDOW_MS,
  MAX_ATTACK_LOG,
} from './constants';

// ─── GameEngine ───────────────────────────────────────────────────────────────
//
// Conține toată logica de stare a jocului. Primește referințe la `io`,
// `rooms` și `socketToRoom` la inițializare – fără singleton-uri globale.

export class GameEngine {
  constructor(
    private io: Server,
    public rooms: Map<string, Room>,
    public socketToRoom: Map<string, string>,
  ) {}

  /** Emite un event direct în camera dată (fără snapshot). */
  emitToRoom(roomCode: string, event: string, data: unknown): void {
    this.io.to(roomCode).emit(event, data);
  }

  /** Accesează socket-ul unui client după id (pentru kick). */
  getSocket(socketId: string) {
    return this.io.sockets.sockets.get(socketId);
  }

  /** Scoate toți socketii dintr-un canal. */
  socketsLeave(roomCode: string): void {
    this.io.socketsLeave(roomCode);
  }

  // ── Broadcast & persistență ─────────────────────────────────────────────────

  broadcastRoom(room: Room): void {
    this.io.to(room.code).emit('room_updated', roomSnapshot(room));
    persistRoom(room).catch(console.error);
  }

  deleteRoom(code: string): void {
    this.rooms.delete(code);
    deletePersistedRoom(code).catch(console.error);
  }

  addAttackLog(
    room: Room,
    message: string,
    opts?: { attackerId?: string; victimId?: string },
  ): void {
    const entry: AttackLogEntry = {
      id: logId(),
      timestamp: Date.now(),
      message,
      ...opts,
    };
    // Limităm dimensiunea log-ului în memorie
    if (room.attackLog.length >= MAX_ATTACK_LOG) room.attackLog.shift();
    room.attackLog.push(entry);
    this.io.to(room.code).emit('attack_log', entry);
  }

  // ── Ciclu de viață al jocului ────────────────────────────────────────────────

  endGame(room: Room, reason: 'time' | 'one_left' | 'no_players'): void {
    if (room.phase === 'finished') return;
    room.phase = 'finished';

    if (room.gameTimeout) clearTimeout(room.gameTimeout as ReturnType<typeof setTimeout>);

    // Bonus supraviețuire
    const survivors = activePlayers(room);
    survivors.forEach((p) => { p.score += SURVIVAL_BONUS; });

    if (survivors.length > 0) {
      const names = survivors.map((p) => p.name).join(', ');
      this.addAttackLog(room, `${names} a primit bonus de supraviețuire (+${SURVIVAL_BONUS} pct).`);
    }

    // Clasament final (jucătorii cu status 'left' de la start sunt excluși)
    const ranking = Array.from(room.players.values())
      .filter((p) => p.status !== 'left')
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const rank = (p: Player) => (p.status === 'active' ? 0 : 1);
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
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

    this.io.to(room.code).emit('game_ended', {
      reason,
      ranking,
      room: roomSnapshot(room),
    });
  }

  startCountdown(room: Room): void {
    room.phase = 'countdown';
    this.broadcastRoom(room);

    let count = 10; // COUNTDOWN_FROM inline ca să evităm import circular
    this.io.to(room.code).emit('countdown_tick', { count });

    room.countdownInterval = setInterval(() => {
      count--;
      this.io.to(room.code).emit('countdown_tick', { count });

      if (count <= 0) {
        clearInterval(room.countdownInterval as ReturnType<typeof setInterval>);
        this.startGame(room);
      }
    }, 1000);
  }

  startGame(room: Room): void {
    room.phase = 'playing';
    room.startedAt = Date.now();
    room.endsAt = Date.now() + room.timeLimitMs;

    // Jucătorii fără cod ales sunt scoși din joc
    Array.from(room.players.values()).forEach((p) => {
      if (!p.hasChosenCode) p.status = 'left';
    });

    this.broadcastRoom(room);
    this.io.to(room.code).emit('game_started', { endsAt: room.endsAt });

    room.gameTimeout = setTimeout(
      () => this.endGame(room, 'time'),
      room.timeLimitMs,
    );
  }

  // ── Gestionare leave / disconnect ───────────────────────────────────────────

  handleLeave(
    socket: Socket,
    roomCode: string,
    reason: 'voluntary' | 'disconnect',
  ): void {
    const room = this.rooms.get(roomCode);
    if (!room) return;

    const player = room.players.get(socket.id);
    if (!player) return;

    this.socketToRoom.delete(socket.id);

    if (room.phase === 'lobby') {
      room.players.delete(socket.id);
      socket.leave(roomCode);

      if (room.players.size === 0) {
        this.deleteRoom(roomCode);
        return;
      }

      // Transfer host dacă e nevoie
      if (room.hostId === socket.id) {
        const next = Array.from(room.players.values())[0];
        next.isHost = true;
        room.hostId = next.id;
      }

      this.broadcastRoom(room);
      return;
    }

    if (room.phase === 'playing' || room.phase === 'countdown') {
      if (reason === 'disconnect') {
        player.status = 'disconnected';
        player.disconnectedAt = Date.now();
        this.addAttackLog(room, `${player.name} s-a deconectat.`);
        this.broadcastRoom(room);

        if (room.phase === 'playing' && inGamePlayers(room).length === 0) {
          this.endGame(room, 'no_players');
          return;
        }

        // Fereastră reconectare: dacă nu revine în RECONNECT_WINDOW_MS → left
        setTimeout(() => {
          const current = room.players.get(socket.id);
          if (current && current.status === 'disconnected') {
            current.status = 'left';
            this.addAttackLog(room, `${player.name} a ieșit definitiv din joc.`);
            this.broadcastRoom(room);

            if (room.phase === 'playing' && activePlayers(room).length <= 1) {
              this.endGame(
                room,
                activePlayers(room).length === 0 ? 'no_players' : 'one_left',
              );
            }
          }
        }, RECONNECT_WINDOW_MS);
      } else {
        // Ieșire voluntară
        player.status = 'left';
        socket.leave(roomCode);
        this.addAttackLog(room, `${player.name} a părăsit jocul.`);
        this.broadcastRoom(room);

        if (room.hostId === socket.id) {
          const next = Array.from(room.players.values()).find(
            (p) => p.status === 'active',
          );
          if (next) { next.isHost = true; room.hostId = next.id; }
        }

        if (room.phase === 'playing' && activePlayers(room).length <= 1) {
          this.endGame(
            room,
            activePlayers(room).length === 0 ? 'no_players' : 'one_left',
          );
        }
      }
    }
  }
}
