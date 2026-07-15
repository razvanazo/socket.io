// ─── Types ────────────────────────────────────────────────────────────────────

export type PlayerStatus = 'active' | 'eliminated' | 'left' | 'disconnected';

export type GamePhase =
  | 'lobby'
  | 'countdown'
  | 'playing'
  | 'finished';

export interface Player {
  id: string;          // socket id
  name: string;
  isHost: boolean;
  isReady: boolean;
  hasChosenCode: boolean;  // true odată ce jucătorul a setat propriul cod
  status: PlayerStatus;
  score: number;
  eliminations: number;
  lastEliminationAt: number | null;
  joinedAt: number;
  disconnectedAt: number | null;
  targetCode: string;  // the code others must crack
}

export interface AttackLogEntry {
  id: string;
  timestamp: number;
  message: string;
  attackerId?: string;
  victimId?: string;
}

export interface Room {
  code: string;
  hostId: string;
  maxPlayers: number;
  timeLimitMs: number;
  phase: GamePhase;
  players: Map<string, Player>;
  startedAt: number | null;
  endsAt: number | null;
  attackLog: AttackLogEntry[];
  countdownInterval: unknown;
  gameTimeout: unknown;
}

// ─── Socket event payloads ─────────────────────────────────────────────────────

export interface CreateRoomPayload {
  playerName: string;
  maxPlayers: number;
  timeLimitMs: number;
}

export interface JoinRoomPayload {
  roomCode: string;
  playerName: string;
}

export interface SubmitGuessPayload {
  roomCode: string;
  targetPlayerId: string;
  guess: string;
}

export interface SelectTargetPayload {
  roomCode: string;
  targetPlayerId: string;
}

export interface CellResult {
  digit: string;
  status: 'correct' | 'present' | 'absent';
}
