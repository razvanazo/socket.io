import { Room, Player, AttackLogEntry, CellResult } from './types';
import { WORD_LENGTH, SNAPSHOT_ATTACK_LOG } from './constants';

// ─── Generatoare ──────────────────────────────────────────────────────────────

export function generateRoomCode(existing: Map<string, unknown>): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return existing.has(code) ? generateRoomCode(existing) : code;
}

export function generateTargetCode(): string {
  return Array.from({ length: WORD_LENGTH }, () =>
    Math.floor(Math.random() * 10).toString()
  ).join('');
}

export function logId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ─── Snapshot (ce trimitem clienților – fără targetCode!) ─────────────────────

export function roomSnapshot(room: Room) {
  return {
    code: room.code,
    hostId: room.hostId,
    maxPlayers: room.maxPlayers,
    timeLimitMs: room.timeLimitMs,
    phase: room.phase,
    startedAt: room.startedAt,
    endsAt: room.endsAt,
    attackLog: room.attackLog.slice(-SNAPSHOT_ATTACK_LOG),
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

// ─── Interogări pe Room ───────────────────────────────────────────────────────

export function activePlayers(room: Room): Player[] {
  return Array.from(room.players.values()).filter((p) => p.status === 'active');
}

/** Jucători activi sau în fereastra de reconectare (deconectați < 30s). */
export function inGamePlayers(room: Room): Player[] {
  return Array.from(room.players.values()).filter(
    (p) => p.status === 'active' || p.status === 'disconnected'
  );
}

// ─── Logica de ghicire ────────────────────────────────────────────────────────

export function evaluateGuess(guess: string, target: string): CellResult[] {
  const result: CellResult[] = Array(WORD_LENGTH).fill(null).map((_, i) => ({
    digit: guess[i],
    status: 'absent' as const,
  }));
  const targetCounts: Record<string, number> = {};

  // Prima trecere: poziții corecte
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (guess[i] === target[i]) {
      result[i] = { digit: guess[i], status: 'correct' };
    } else {
      targetCounts[target[i]] = (targetCounts[target[i]] || 0) + 1;
    }
  }

  // A doua trecere: cifre prezente, poziție greșită
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (result[i].status === 'correct') continue;
    if (targetCounts[guess[i]] > 0) {
      result[i] = { digit: guess[i], status: 'present' };
      targetCounts[guess[i]]--;
    }
  }

  return result;
}
