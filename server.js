import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';

const app = express();
app.use(express.static('public'));
const http = createServer(app);
const io = new Server(http);

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const KEY = process.env.OPENAI_API_KEY;
const LIMIT = 4; // questions per player
const SEARCHES = 2; // scene searches per player
const rooms = new Map();

async function chat(messages, json = false) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
            model: MODEL,
            messages,
            temperature: 0.9,
            max_tokens: json ? 2000 : 220,
            ...(json && { response_format: { type: 'json_object' } }),
        }),
        signal: AbortSignal.timeout(40000),
    });
    if (!r.ok) throw new Error(await r.text());
    return (await r.json()).choices[0].message.content;
}

const FALLBACK = {
    title: 'Death at the Lighthouse',
    setting: 'A storm-bound lighthouse on a cliff, 1926',
    victim: 'Edmund Hale, the lighthouse owner, found at the foot of the stairs',
    suspects: [
        { id: 's1', name: 'Mara Quinn', role: 'Housekeeper', personality: 'Nervous, precise', alibi: 'Was polishing silver in the kitchen all night', secret: 'Was stealing small items from Edmund' },
        { id: 's2', name: 'Dr. Felix Arden', role: 'Family doctor', personality: 'Smooth, condescending', alibi: 'Was asleep in the guest room from 10pm', secret: 'Edmund knew about his gambling debts' },
        { id: 's3', name: 'Iris Hale', role: "Edmund's niece", personality: 'Sharp, grieving', alibi: 'Was reading in the library until midnight', secret: 'Edmund was about to cut her from his will' },
        { id: 's4', name: 'Tobias Reed', role: 'Keeper', personality: 'Gruff, loyal', alibi: 'Was tending the lamp at the top of the tower', secret: 'Left the lamp unattended to drink' },
    ],
    culpritId: 's2',
    clues: [
        { suspectId: 's2', text: 'The guest room bed was never slept in, and his coat is wet from the rain.' },
        { suspectId: 's1', text: 'Silver spoons from Edmund\'s drawer are in her apron.' },
        { suspectId: 's3', text: 'A torn page of the will was in the library fireplace.' },
        { suspectId: 's4', text: 'The lamp went dark for 20 minutes at 11pm.' },
    ],
    reveal: 'Dr. Arden claimed to be asleep, but his bed was untouched and his coat was soaked. He pushed Edmund down the stairs to erase his debt.',
};

async function makeCase() {
    if (!KEY) return FALLBACK;
    const prompt = `Create a fair murder mystery for 2-6 players. Return JSON only:
{"title","setting","victim","suspects":[{"id":"s1","name","role","personality","alibi","secret"}],"culpritId","clues":[{"suspectId","text"}],"reveal"}
Rules: exactly 5 suspects with ids s1-s5. Every suspect has a claimed alibi and a secret that makes them look suspicious. The culprit's alibi must be false and contradicted by one concrete clue. Each innocent's secret is revealed by a clue that explains their suspicious behaviour. 6-8 clues total. "reveal" is 3 sentences explaining who did it and how the clues prove it.`;
    for (let i = 0; i < 2; i++) {
        try {
            const c = JSON.parse(await chat([{ role: 'user', content: prompt }], true));
            if (c.suspects?.length >= 3 && c.suspects.some(s => s.id === c.culpritId) && c.clues?.length) return c;
        } catch (e) { console.error('case gen failed:', e.message); }
    }
    return FALLBACK;
}

async function answer(room, suspect, question) {
    const c = room.case,
        guilty = suspect.id === c.culpritId;
    const mine = c.clues.filter(x => x.suspectId === suspect.id).map(x => x.text).join(' ');
    const system = `You play ${suspect.name}, ${suspect.role}, in a murder mystery. Setting: ${c.setting}. Victim: ${c.victim}.
Personality: ${suspect.personality}. Your claimed alibi: ${suspect.alibi}. Your secret: ${suspect.secret}.
Facts that exist about you: ${mine}
${guilty ? 'You ARE the killer. Never confess. Stick to your alibi, deflect, and get slightly evasive or inconsistent when pressed on the facts above.'
  : 'You are innocent. Hide your secret at first, but admit it if pressed hard or shown evidence. Do not accuse anyone without a reason.'}
Reply in character in at most 3 sentences. Never mention being an AI or the game.`;
    const history = room.log.filter(l => l.suspectId === suspect.id).slice(-6)
        .flatMap(l => [{ role: 'user', content: l.q }, { role: 'assistant', content: l.a }]);
    return chat([{ role: 'system', content: system }, ...history, { role: 'user', content: question }]);
}

const code = () => { let s;
    do s = Math.random().toString(36).slice(2, 6).toUpperCase(); while (rooms.has(s)); return s; };
const live = r => [...r.players.values()].filter(p => !p.left);

function view(room, id) {
    const c = room.case;
    return {
        code: room.code,
        phase: room.phase,
        host: room.host,
        you: id,
        limit: LIMIT,
        searches: SEARCHES,
        players: [...room.players].map(([pid, p]) => ({ id: pid, name: p.name, left: p.left, asked: p.asked, searched: p.searched, voted: !!room.votes[pid] })),
        suspects: c?.suspects.map(({ id, name, role, personality, alibi }) => ({ id, name, role, personality, alibi })),
        title: c?.title,
        setting: c?.setting,
        victim: c?.victim,
        log: room.log,
        result: room.phase === 'reveal' ? { culpritId: c.culpritId, reveal: c.reveal, clues: c.clues, votes: room.votes } : null,
    };
}

function broadcast(room) { for (const [id, p] of room.players)
        if (!p.left) io.to(id).emit('state', view(room, id)); }

function checkVotes(room) {
    if (room.phase === 'play' && live(room).length && live(room).every(p => room.votes[p.id])) { room.phase = 'reveal'; }
    broadcast(room);
}

io.on('connection', socket => {
    let room;
    const join = (r, name) => { room = r;
        r.players.set(socket.id, { id: socket.id, name: String(name).slice(0, 20) || 'Detective', asked: 0, searched: 0, left: false });
        socket.join(r.code); };

    socket.on('create', ({ name }, cb) => {
        const r = { code: code(), host: socket.id, players: new Map(), phase: 'lobby', case: null, log: [], votes: {} };
        rooms.set(r.code, r);
        join(r, name);
        cb({ ok: true });
        broadcast(r);
    });
    socket.on('join', ({ name, code: c }, cb) => {
        const r = rooms.get(String(c).toUpperCase().trim());
        if (!r) return cb({ error: 'Room not found. Check the code.' });
        if (r.phase !== 'lobby') return cb({ error: 'That game has already started.' });
        if (r.players.size >= 6) return cb({ error: 'Room is full (6 players).' });
        join(r, name);
        cb({ ok: true });
        broadcast(r);
    });
    socket.on('start', async() => {
        if (!room || room.host !== socket.id || room.phase !== 'lobby') return;
        room.phase = 'loading';
        broadcast(room);
        room.case = await makeCase();
        room.phase = 'play';
        broadcast(room);
    });
    socket.on('ask', async({ suspectId, question }) => {
        const p = room?.players.get(socket.id);
        const s = room?.case?.suspects.find(x => x.id === suspectId);
        question = String(question || '').trim().slice(0, 200);
        if (!p || !s || !question || room.phase !== 'play' || p.asked >= LIMIT || p.busy) return;
        p.busy = true;
        p.asked++;
        broadcast(room);
        let a;
        try { a = await answer(room, s, question); } catch (e) { console.error(e.message);
            p.asked--;
            a = '(No answer. The suspect stays silent. Your question was refunded, so try again.)'; }
        p.busy = false;
        room.log.push({ player: p.name, suspectId, q: question, a });
        broadcast(room);
    });
    socket.on('search', () => {
        const p = room?.players.get(socket.id);
        if (!p || room.phase !== 'play' || p.searched >= SEARCHES) return;
        const seen = new Set(room.log.filter(l => l.clue).map(l => l.clue));
        const left = room.case.clues.filter(c => !seen.has(c.text));
        if (!left.length) return;
        p.searched++;
        room.log.push({ player: p.name, clue: left[Math.floor(Math.random() * left.length)].text });
        broadcast(room);
    });
    socket.on('again', () => {
        if (!room || room.host !== socket.id || room.phase !== 'reveal') return;
        for (const [id, p] of room.players) p.left ? room.players.delete(id) : Object.assign(p, { asked: 0, searched: 0, busy: false });
        Object.assign(room, { phase: 'lobby', case: null, log: [], votes: {} });
        broadcast(room);
    });
    socket.on('accuse', ({ suspectId }) => {
        if (!room || room.phase !== 'play' || room.votes[socket.id] || !room.case.suspects.some(s => s.id === suspectId)) return;
        room.votes[socket.id] = suspectId;
        checkVotes(room);
    });
    socket.on('disconnect', () => {
        const p = room?.players.get(socket.id);
        if (!p) return;
        p.left = true;
        if (!live(room).length) return rooms.delete(room.code);
        if (room.host === socket.id) room.host = live(room)[0].id;
        checkVotes(room);
    });
});

http.listen(process.env.PORT || 3000, () => console.log('Murder mystery on http://localhost:' + (process.env.PORT || 3000)));