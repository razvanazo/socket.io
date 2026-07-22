import Redis from 'ioredis';
import { Room, Player, AttackLogEntry } from './types';

// ─── Client ───────────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) throw new Error('REDIS_URL env var lipsă – configurează-l pe Railway.');

export const redis = new Redis(REDIS_URL);

redis.on('connect', () => console.log('[redis] conectat'));
redis.on('error', (err) => console.error('[redis] eroare:', err.message));

// ─── Chei ─────────────────────────────────────────────────────────────────────

const ROOM_KEY = (code: string) => `room:${code}`;
const ROOM_TTL_SEC = 60 * 60 * 2; // 2 ore

// ─── Tipuri serializabile (fără handles de timere) ────────────────────────────

interface SerializedRoom {
  code: string;
  hostId: string;
  maxPlayers: number;
  timeLimitMs: number;
  phase: string;
  startedAt: number | null;
  endsAt: number | null;
  attackLog: AttackLogEntry[];
  players: Player[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export async function persistRoom(room: Room): Promise<void> {
  const data: SerializedRoom = {
    code: room.code,
    hostId: room.hostId,
    maxPlayers: room.maxPlayers,
    timeLimitMs: room.timeLimitMs,
    phase: room.phase,
    startedAt: room.startedAt,
    endsAt: room.endsAt,
    attackLog: room.attackLog.slice(-50),
    players: Array.from(room.players.values()),
  };

  await redis.set(ROOM_KEY(room.code), JSON.stringify(data), 'EX', ROOM_TTL_SEC);
}

export async function deletePersistedRoom(code: string): Promise<void> {
  await redis.del(ROOM_KEY(code));
}

/**
 * Încarcă din Redis toate camerele în faza 'lobby'.
 * Camerele în faza 'playing' / 'finished' nu pot fi restaurate corect
 * (socket IDs și handlere de timere sunt invalide după restart).
 */
export async function loadLobbyRooms(): Promise<Room[]> {
  const keys = await redis.keys('room:*');
  if (keys.length === 0) return [];

  const rooms: Room[] = [];

  for (const key of keys) {
    try {
      const raw = await redis.get(key);
      if (!raw) continue;

      const data: SerializedRoom = JSON.parse(raw);

      // Restaurăm doar camerele în lobby (restul au socket IDs invalide)
      if (data.phase !== 'lobby') {
        await redis.del(key); // curățăm camerele expirate
        continue;
      }

      // Reconstruim Map<string, Player> din array
      const playersMap = new Map<string, Player>(
        data.players.map((p) => [p.id, p])
      );

      const room: Room = {
        code: data.code,
        hostId: data.hostId,
        maxPlayers: data.maxPlayers,
        timeLimitMs: data.timeLimitMs,
        phase: 'lobby',
        startedAt: null,
        endsAt: null,
        attackLog: data.attackLog,
        players: playersMap,
        countdownInterval: null,
        gameTimeout: null,
      };

      rooms.push(room);
      console.log(`[redis] camera ${data.code} restaurată (${playersMap.size} jucători)`);
    } catch (e) {
      console.warn(`[redis] eroare la parsarea cheii ${key}:`, e);
    }
  }

  return rooms;
}
