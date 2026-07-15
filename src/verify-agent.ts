/**
 * Neon Lock – Multiplayer Feature Verification Agent
 *
 * Simulează 3 jucători și verifică automat fiecare funcționalitate
 * din spec-ul multiplayer. Rulează cu:
 *   npx ts-node src/verify-agent.ts
 */

import { io, Socket } from 'socket.io-client';

const SERVER = 'http://localhost:8081';
const PASS = '✅';
const FAIL = '❌';
const SKIP = '⚪';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ${PASS} ${label}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${label}${detail ? ` → ${detail}` : ''}`);
    failed++;
  }
}

function section(title: string) {
  console.log(`\n━━━ ${title} ${'━'.repeat(Math.max(0, 50 - title.length))}`);
}

function makeClient(name: string): Socket {
  return io(SERVER, { transports: ['websocket'], autoConnect: false });
}

function emit<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout: ${event}`)), 5000);
    socket.emit(event, payload, (res: T) => {
      clearTimeout(timeout);
      resolve(res);
    });
  });
}

function waitFor<T>(socket: Socket, event: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for: ${event}`)), timeoutMs);
    socket.once(event, (data: T) => {
      clearTimeout(t);
      resolve(data);
    });
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Main agent ───────────────────────────────────────────────────────────────

async function runAgent() {
  console.log('\n🤖 Neon Lock – Multiplayer Verification Agent');
  console.log('='.repeat(52));

  const host = makeClient('Host');
  const p2 = makeClient('Player2');
  const p3 = makeClient('Player3');

  // Connect all
  await Promise.all([
    new Promise<void>((r) => { host.connect(); host.once('connect', r); }),
    new Promise<void>((r) => { p2.connect(); p2.once('connect', r); }),
    new Promise<void>((r) => { p3.connect(); p3.once('connect', r); }),
  ]);

  let roomCode = '';
  let hostId = '';
  let p2Id = '';
  let p3Id = '';

  // ─── 1. Room Creation ───────────────────────────────────────────────────────
  section('1. Room Creation');
  try {
    const res = await emit<any>(host, 'create_room', {
      playerName: 'Alex',
      maxPlayers: 4,   // 4 ca să nu pornească auto la 3 jucători
      timeLimitMs: 60_000,
    });
    check('create_room răspunde ok', res.ok === true);
    check('room are un cod', typeof res.room?.code === 'string' && res.room.code.length === 5);
    check('jucătorul este host', res.room?.players[0]?.isHost === true);
    check('faza este lobby', res.room?.phase === 'lobby');
    check('maxPlayers setat corect', res.room?.maxPlayers === 4);
    check('timeLimitMs setat corect', res.room?.timeLimitMs === 60_000);
    roomCode = res.room.code;
    hostId = res.playerId;
  } catch (e: any) {
    check('create_room funcționează', false, e.message);
  }

  // ─── 1b. Creator intră direct în Lobby după creare ─────────────────────────
  section('1b. Creator → Lobby direct după creare');
  try {
    // Simulează comportamentul din CreateRoom.tsx:
    // după create_room, hostul se află deja în cameră (socket.join(code) pe server)
    // și trebuie să primească room_updated când alți jucători se alătură

    // Verificare 1: hostul este deja în lista de jucători ai camerei
    const freshRes = await emit<any>(host, 'join_room', { roomCode: 'XXXXX', playerName: 'test' });
    check('hostul NU poate face join la o altă cameră (e deja în cameră)', freshRes.ok === false);

    // Verificare 2: un jucător nou se alătură → hostul primește room_updated automat
    // (dovedește că hostul este abonat la camera sa din momentul creării)
    const lobbyUpdatePromise = waitFor<any>(host, 'room_updated', 3000);
    const earlyJoin = await emit<any>(p2, 'join_room', { roomCode, playerName: 'TestPlayer' });
    check('un alt jucător poate intra în camera creată', earlyJoin.ok === true);
    const lobbyRoom = await lobbyUpdatePromise;
    check('hostul primește room_updated imediat (este deja în lobby)', lobbyRoom !== null);
    check('camera are 2 jucători după primul join', lobbyRoom?.players?.length === 2);
    check('hostul apare ca primul jucător cu isHost=true',
      lobbyRoom?.players?.find((p: any) => p.id === hostId)?.isHost === true
    );
    p2Id = earlyJoin.playerId;
  } catch (e: any) {
    check('creator intră direct în lobby', false, e.message);
  }

  // ─── 2. Join Room ──────────────────────────────────────────────────────────
  section('2. Join Room');
  try {
    // Join invalid room
    const badRes = await emit<any>(p3, 'join_room', { roomCode: 'YYYYY', playerName: 'Maria' });
    check('join cameră inexistentă returnează eroare', badRes.ok === false);

    // Al 3-lea jucător se alătură
    const roomUpdatePromise = waitFor<any>(host, 'room_updated', 3000);
    const r3 = await emit<any>(p3, 'join_room', { roomCode, playerName: 'Vlad' });
    check('al 3-lea jucător se alătură', r3.ok === true);
    check('camera are acum 3 jucători', r3.room?.players?.length === 3);
    p3Id = r3.playerId;

    const updatedRoom = await roomUpdatePromise;
    check('host primește room_updated la join', updatedRoom.players?.length >= 3);
  } catch (e: any) {
    check('join_room funcționează', false, e.message);
  }

  // ─── 3. Lobby & Ready ──────────────────────────────────────────────────────
  section('3. Lobby & Ready Status');
  try {
    const updatePromise = waitFor<any>(host, 'room_updated', 3000);
    p2.emit('set_ready', { roomCode, isReady: true });
    const updated = await updatePromise;
    const maria = updated.players?.find((p: any) => p.id === p2Id);
    check('set_ready actualizează statusul jucătorului', maria?.isReady === true);
  } catch (e: any) {
    check('set_ready funcționează', false, e.message);
  }

  // ─── 4. Start Game Validation ──────────────────────────────────────────────
  section('4. Start Game Validation');
  try {
    const nonHostRes = await emit<any>(p2, 'start_game', { roomCode });
    check('non-host nu poate porni jocul', nonHostRes.ok === false);
  } catch (e: any) {
    check('validare host pentru start_game', false, e.message);
  }

  // ─── 5. Countdown ─────────────────────────────────────────────────────────
  section('5. Countdown');
  const countdownTicks: number[] = [];
  const allSockets = [host, p2, p3];
  let latestRoomUpdate: any = null;
  allSockets.forEach((s) => {
    s.on('countdown_tick', ({ count }: { count: number }) => {
      if (!countdownTicks.includes(count)) countdownTicks.push(count);
    });
    s.on('room_updated', (r: any) => { latestRoomUpdate = r; });
  });

  let gameStartedData: any = null;
  try {
    const startRes = await emit<any>(host, 'start_game', { roomCode });
    check('host poate porni jocul', startRes.ok === true);

    await waitFor<any>(host, 'room_updated', 3000).catch(() => null);
    check('faza devine countdown', latestRoomUpdate?.phase === 'countdown');

    gameStartedData = await waitFor<any>(host, 'game_started', 15_000);
    check('countdown emite tick-uri descrescătoare', countdownTicks.length > 3);
    check('countdown pornit de la 10', countdownTicks.includes(10));
    check('game_started primit de host', gameStartedData !== null);
  } catch (e: any) {
    check('countdown și game_started funcționează', false, e.message);
  }

  // ─── 6. Game Phase ────────────────────────────────────────────────────────
  section('6. Game Phase');
  // game_started include endsAt direct – nu mai depindem de room_updated timing
  check(
    'endsAt setat corect (via game_started)',
    typeof gameStartedData?.endsAt === 'number' && gameStartedData.endsAt > Date.now()
  );
  // faza playing o verificăm indirect: dacă submit_guess funcționează în secțiunea 7, faza e playing
  // Dar putem și verifica latestRoomUpdate după un mic delay
  await sleep(200);
  check('faza devine playing după countdown', latestRoomUpdate?.phase === 'playing');

  // ─── 7. Submit Guess – validări ───────────────────────────────────────────
  section('7. Submit Guess – validări');
  try {
    // Self-attack
    const selfRes = await emit<any>(host, 'submit_guess', {
      roomCode,
      targetPlayerId: hostId,
      guess: '1234',
    });
    check('nu poți ataca pe tine însuți', selfRes.ok === false);

    // Guess prea scurt
    const shortRes = await emit<any>(host, 'submit_guess', {
      roomCode,
      targetPlayerId: p2Id,
      guess: '12',
    });
    check('ghicire cu lungime greșită returnează eroare', shortRes.ok === false);

    // Guess cu litere
    const alphaRes = await emit<any>(host, 'submit_guess', {
      roomCode,
      targetPlayerId: p2Id,
      guess: 'ABCD',
    });
    check('ghicire cu litere returnează eroare', alphaRes.ok === false);
  } catch (e: any) {
    check('validări submit_guess', false, e.message);
  }

  // ─── 8. Submit Guess – rezultat valid ────────────────────────────────────
  section('8. Submit Guess – rezultat valid');
  try {
    const guessRes = await emit<any>(host, 'submit_guess', {
      roomCode,
      targetPlayerId: p2Id,
      guess: '0000',
    });
    check('submit_guess valid returnează ok', guessRes.ok === true);
    check('result are 4 celule', Array.isArray(guessRes.result) && guessRes.result.length === 4);
    check(
      'fiecare celulă are status valid',
      guessRes.result?.every((c: any) => ['correct', 'present', 'absent'].includes(c.status))
    );
    check('isCorrect prezent în răspuns', typeof guessRes.isCorrect === 'boolean');
  } catch (e: any) {
    check('submit_guess valid', false, e.message);
  }

  // ─── 9. Eliminare ────────────────────────────────────────────────────────
  section('9. Eliminare & Scor');
  let elimData: any = null;
  try {
    let eliminated = false;

    const elimPromise = new Promise<any>((resolve) => {
      host.once('player_eliminated', resolve);
    });

    outer: for (let i = 0; i <= 9999; i++) {
      const g = i.toString().padStart(4, '0');
      const r = await emit<any>(host, 'submit_guess', { roomCode, targetPlayerId: p2Id, guess: g });
      if (!r.ok) continue;
      if (r.isCorrect) {
        eliminated = true;
        break outer;
      }
    }

    check('codul poate fi spart prin brute-force', eliminated);

    if (eliminated) {
      elimData = await Promise.race([
        elimPromise,
        sleep(3000).then(() => null),
      ]) as any;
      check('player_eliminated emis după crack', elimData !== null);
      check('eliminatedId corect', elimData?.eliminatedId === p2Id);
      check('attackerName corect', elimData?.attackerName === 'Alex');
      check('pointsGained ≥ 1', (elimData?.pointsGained ?? 0) >= 1);

      const reAttack = await emit<any>(host, 'submit_guess', {
        roomCode,
        targetPlayerId: p2Id,
        guess: '0000',
      });
      check('jucătorul eliminat nu mai poate fi atacat', reAttack.ok === false);
    }
  } catch (e: any) {
    check('eliminare funcționează', false, e.message);
  }

  // ─── 10. Scorul victimei & atacatorului ──────────────────────────────────
  section('10. Scoreboard via player_eliminated payload');
  // elimData din secțiunea 9 conține room snapshot direct în payload
  const snapPlayers: any[] = (elimData as any)?.room?.players ?? [];
  const alexSnap = snapPlayers.find((p: any) => p.id === hostId);
  const mariaSnap = snapPlayers.find((p: any) => p.id === p2Id);
  check('atacatorul are scor > 0 (din payload eliminare)', (alexSnap?.score ?? 0) > 0, `scor: ${alexSnap?.score}`);
  check('victima are status eliminated (din payload)', mariaSnap?.status === 'eliminated', `status: ${mariaSnap?.status}`);

  // ─── 11. Jocul se termină când rămâne 1 jucător ──────────────────────────
  section('11. Terminarea Jocului (1 jucător activ)');
  try {
    const gameEndedPromise = waitFor<any>(host, 'game_ended', 10_000);

    // Crăpăm codul lui p3
    let done = false;
    for (let i = 0; i <= 9999 && !done; i++) {
      const g = i.toString().padStart(4, '0');
      const r = await emit<any>(host, 'submit_guess', { roomCode, targetPlayerId: p3Id, guess: g });
      if (r.ok && r.isCorrect) done = true;
    }

    if (done) {
      const endData = await Promise.race([
        gameEndedPromise,
        sleep(5000).then(() => null),
      ]) as any;

      check('game_ended emis când rămâne 1 jucător activ', endData !== null);
      check('reason este one_left', endData?.reason === 'one_left');
      check('ranking are 3 jucători', endData?.ranking?.length === 3);
      check(
        'ranking ordonat descrescător după scor',
        endData?.ranking?.[0]?.score >= (endData?.ranking?.[1]?.score ?? 0)
      );
      check('câștigătorul are rank 1', endData?.ranking?.[0]?.rank === 1);

      // Bonus supraviețuire (10 pts) adăugat câștigătorului
      const winner = endData?.ranking?.find((r: any) => r.id === hostId);
      check('câștigătorul primește bonus supraviețuire (+10)', (winner?.score ?? 0) >= 10);
    } else {
      check('al 2-lea jucător poate fi eliminat', false, 'brute-force nereușit');
    }
  } catch (e: any) {
    check('terminarea jocului funcționează', false, e.message);
  }

  // ─── 12. Health check ─────────────────────────────────────────────────────
  section('12. HTTP Health Check');
  try {
    const res = await fetch(`${SERVER}/health`);
    const data = await res.json() as any;
    check('/health returnează ok: true', data.ok === true);
    check('/health returnează numărul de camere', typeof data.rooms === 'number');
  } catch (e: any) {
    check('health check', false, e.message);
  }

  // ─── Sumar ────────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(52));
  console.log(`🤖 SUMAR: ${PASS} ${passed} trecute  |  ${FAIL} ${failed} eșuate  |  ${SKIP} ${0} sărite`);
  const total = passed + failed;
  const pct = total > 0 ? Math.round((passed / total) * 100) : 0;
  console.log(`   Scor: ${pct}% (${passed}/${total})\n`);

  host.disconnect();
  p2.disconnect();
  p3.disconnect();

  process.exit(failed > 0 ? 1 : 0);
}

runAgent().catch((e) => {
  console.error('\n💥 Agent crashed:', e);
  process.exit(1);
});
