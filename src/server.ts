import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { Room } from './types';
import { loadLobbyRooms } from './redis';
import { GameEngine } from './engine';
import { registerHandlers } from './handlers';
import { PORT } from './constants';

// ─── App & HTTP ───────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

// ─── State ────────────────────────────────────────────────────────────────────

const rooms = new Map<string, Room>();
const socketToRoom = new Map<string, string>();
const engine = new GameEngine(io, rooms, socketToRoom);

// ─── Socket handlers ──────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} conectat`);
  registerHandlers(socket, engine);
});

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  try {
    const saved = await loadLobbyRooms();
    for (const room of saved) rooms.set(room.code, room);
    if (saved.length > 0) {
      console.log(`[redis] ${saved.length} cameră/camere din lobby restaurate.`);
    }
  } catch (e) {
    console.warn('[redis] Nu s-au putut restaura camerele:', e);
  }

  httpServer.listen(PORT, () => {
    console.log(`🚀 Neon Lock backend pornit pe portul ${PORT}`);
  });
}

main();
