import Redis from 'ioredis';
import { Room, Player, AttackLogEntry } from './types';

// ─── Client (lazy – instanțiat la primul apel, nu la import) ─────────────────
//
// Railway injectează env vars la runtime, nu la build time. Dacă am instanția
// Redis la import, serverul ar crăpa în timpul build-ului unde REDIS_URL lipsă.

let _redis: Redis | null = null;

function getRedis(): Redis | null {
  if (_redis) return _redis;

  const url = process.env.REDIS_URL;
  if (!url) {
    console.warn('[redis] REDIS_URL lipsă – camerele nu vor fi persistate.');
    return null;
  }

  _redis = new Redis(url);
  _redis.on('connect', () => console.log('[redis] conectat'));
  _redis.on('error', (err) => console.error('[redis] eroare:', err.message));
  return _redis;
}

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
  const r = getRedis();
  if (!r) return;

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

  await r.set(ROOM_KEY(room.code), JSON.stringify(data), 'EX', ROOM_TTL_SEC);
}

export async function deletePersistedRoom(code: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.del(ROOM_KEY(code));
}

/**
 * Încarcă din Redis toate camerele în faza 'lobby'.
 * Camerele în faza 'playing' / 'finished' nu pot fi restaurate corect
 * (socket IDs și handlere de timere sunt invalide după restart).
 */
export async function loadLobbyRooms(): Promise<Room[]> {
  const r = getRedis();
  if (!r) return [];
  const keys = await r.keys('room:*');
  if (keys.length === 0) return [];

  const rooms: Room[] = [];

  for (const key of keys) {
    try {
      const raw = await r.get(key);
      if (!raw) continue;

      const data: SerializedRoom = JSON.parse(raw);

      // Restaurăm doar camerele în lobby (restul au socket IDs invalide)
      if (data.phase !== 'lobby') {
        await r.del(key); // curățăm camerele expirate
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
