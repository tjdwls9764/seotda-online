const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });
const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_, res) => res.json({ ok: true }));

const rooms = new Map();
const suits = ["매화", "벚꽃", "국화", "단풍"];
const art = {1:"🌺",2:"🐦",3:"🌕",4:"🌿",5:"🌸",6:"🦋",7:"🍁",8:"🌾",9:"🏵️",10:"☀️"};

function makeDeck() {
  const deck = [];
  for (let month = 1; month <= 10; month++) {
    // 섯다용 20장: 각 월 2장
    deck.push({ month, id: `${month}-a`, art: art[month] });
    deck.push({ month, id: `${month}-b`, art: art[month] });
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function evaluate(hand) {
  const [x, y] = hand.map(c => c.month).sort((a,b) => a-b);
  const key = `${x},${y}`;
  const pairs = {
    "3,8":[100,"38광땡"], "1,3":[99,"13광땡"], "1,8":[98,"18광땡"],
    "1,2":[70,"알리"], "1,4":[69,"독사"], "1,9":[68,"구삥"],
    "1,10":[67,"장삥"], "4,10":[66,"장사"], "4,6":[65,"세륙"]
  };
  if (pairs[key]) return { score:pairs[key][0], name:pairs[key][1] };
  if (x === y) return { score:80+x, name:x===10 ? "장땡" : `${x}땡` };
  const n = (x+y)%10;
  if (n === 9) return { score:60, name:"갑오" };
  if (n === 0) return { score:10, name:"망통" };
  return { score:20+n, name:`${n}끗` };
}

function publicRoom(room) {
  return {
    code: room.code,
    players: room.players.map(p => ({ name:p.name, ready:p.ready, connected:p.connected, host:p.host })),
    status: room.status,
    pot: room.pot,
    round: room.round,
    currentBet: room.currentBet,
    turn: room.turn,
    message: room.message
  };
}
function sendState(room) {
  room.players.forEach((p, idx) => {
    if (!p.connected) return;
    io.to(p.id).emit("roomState", {
      ...publicRoom(room),
      me: idx,
      myHand: room.status === "playing" || room.status === "showdown" ? (room.hands[idx] || []).map(c => ({ month:c.month, art:c.art })) : [],
      opponentHasCards: room.status === "playing" || room.status === "showdown",
      result: room.status === "showdown" ? room.result : null,
      balance: p.balance
    });
  });
}
function emitError(socket, message) { socket.emit("notice", { type:"error", message }); }
function getRoomFor(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) : null;
}
function cleanName(name) {
  return String(name || "플레이어").trim().replace(/[<>]/g,"").slice(0,12) || "플레이어";
}
function startRound(room) {
  if (room.players.length !== 2 || room.players.some(p => !p.connected)) return;
  if (room.players.some(p => p.balance < 1000)) {
    room.status = "waiting";
    room.message = "칩이 부족한 플레이어가 있습니다. 새 방을 만들거나 초기화해 주세요.";
    sendState(room); return;
  }
  const deck = makeDeck();
  room.hands = [[deck.pop(), deck.pop()], [deck.pop(), deck.pop()]];
  room.pot = 2000;
  room.currentBet = 1000;
  room.players.forEach(p => { p.balance -= 1000; p.ready = false; });
  room.turn = room.hostIndex;
  room.status = "playing";
  room.result = null;
  room.message = "각자 패를 확인하고 베팅하세요.";
  sendState(room);
}
function settle(room) {
  const a = evaluate(room.hands[0]), b = evaluate(room.hands[1]);
  let winner = a.score === b.score ? -1 : (a.score > b.score ? 0 : 1);
  if (winner === -1) {
    const half = Math.floor(room.pot / 2);
    room.players[0].balance += half;
    room.players[1].balance += room.pot - half;
    room.message = `무승부! ${a.name} · 판돈을 나눴습니다.`;
  } else {
    room.players[winner].balance += room.pot;
    room.message = `${room.players[winner].name} 승리! ${winner === 0 ? a.name : b.name}으로 판돈을 획득했습니다.`;
  }
  room.result = {
    winner,
    hands: room.hands.map(h => h.map(c => ({ month:c.month, art:c.art }))),
    rankings: [a,b]
  };
  room.status = "showdown";
  room.pot = 0;
  sendState(room);
}
function leaveRoom(socket) {
  const room = getRoomFor(socket);
  if (!room) return;
  room.players = room.players.filter(p => p.id !== socket.id);
  socket.data.roomCode = null;
  if (room.players.length === 0) rooms.delete(room.code);
  else {
    room.players[0].host = true;
    room.hostIndex = 0;
    room.status = "waiting";
    room.hands = [[],[]];
    room.pot = 0;
    room.message = "상대가 나갔습니다. 새 상대가 들어오길 기다립니다.";
    room.result = null;
    sendState(room);
  }
}

io.on("connection", socket => {
  socket.on("createRoom", ({ name } = {}) => {
    if (socket.data.roomCode) leaveRoom(socket);
    let code;
    do { code = crypto.randomBytes(3).toString("hex").toUpperCase(); } while (rooms.has(code));
    const room = {
      code, players:[{ id:socket.id, name:cleanName(name), balance:100000, connected:true, ready:true, host:true }],
      status:"waiting", pot:0, currentBet:0, turn:0, hostIndex:0, round:0,
      hands:[[],[]], result:null, message:"친구에게 방 코드를 보내세요."
    };
    rooms.set(code, room);
    socket.data.roomCode = code;
    socket.join(code);
    sendState(room);
  });

  socket.on("joinRoom", ({ code, name } = {}) => {
    if (socket.data.roomCode) leaveRoom(socket);
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return emitError(socket, "방을 찾을 수 없습니다. 방 코드를 확인해 주세요.");
    if (room.players.length >= 2) return emitError(socket, "이미 두 명이 입장한 방입니다.");
    room.players.push({ id:socket.id, name:cleanName(name), balance:100000, connected:true, ready:true, host:false });
    socket.data.roomCode = code;
    socket.join(code);
    room.status = "waiting";
    room.message = "두 명이 모였습니다. 방장이 게임을 시작할 수 있습니다.";
    sendState(room);
  });

  socket.on("startRound", () => {
    const room = getRoomFor(socket);
    if (!room) return emitError(socket, "먼저 방에 입장해 주세요.");
    if (room.players[0]?.id !== socket.id) return emitError(socket, "방장만 새 판을 시작할 수 있습니다.");
    if (room.status === "playing") return emitError(socket, "현재 판이 진행 중입니다.");
    if (room.players.length !== 2) return emitError(socket, "친구가 입장할 때까지 기다려 주세요.");
    room.round++;
    startRound(room);
  });

  socket.on("bet", ({ amount } = {}) => {
    const room = getRoomFor(socket);
    if (!room || room.status !== "playing") return emitError(socket, "베팅할 수 있는 판이 아닙니다.");
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx < 0) return;
    if (room.turn !== idx) return emitError(socket, "상대의 차례입니다.");
    let n = amount === "all" ? room.players[idx].balance : Number(amount);
    if (!Number.isFinite(n) || n <= 0) return emitError(socket, "베팅 금액이 올바르지 않습니다.");
    n = Math.floor(Math.min(n, room.players[idx].balance, 50000));
    room.players[idx].balance -= n;
    room.pot += n;
    room.message = `${room.players[idx].name}님이 ${n.toLocaleString()}칩 베팅했습니다.`;
    room.turn = 1 - idx;
    sendState(room);
  });

  socket.on("call", () => {
    const room = getRoomFor(socket);
    if (!room || room.status !== "playing") return emitError(socket, "현재 진행 중인 판이 없습니다.");
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx < 0 || room.turn !== idx) return emitError(socket, "상대의 차례입니다.");
    const n = Math.min(room.currentBet, room.players[idx].balance);
    room.players[idx].balance -= n;
    room.pot += n;
    room.message = `${room.players[idx].name}님이 콜했습니다. 패를 공개합니다.`;
    settle(room);
  });

  socket.on("showdown", () => {
    const room = getRoomFor(socket);
    if (!room || room.status !== "playing") return emitError(socket, "패를 공개할 수 없습니다.");
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx < 0) return;
    settle(room);
  });

  socket.on("fold", () => {
    const room = getRoomFor(socket);
    if (!room || room.status !== "playing") return emitError(socket, "다이할 수 있는 판이 아닙니다.");
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx < 0) return;
    const winner = 1 - idx;
    room.players[winner].balance += room.pot;
    room.message = `${room.players[idx].name}님이 다이했습니다. ${room.players[winner].name}님 승리!`;
    room.result = { winner, hands:room.hands.map(h=>h.map(c=>({month:c.month,art:c.art}))), rankings:room.hands.map(evaluate) };
    room.status = "showdown";
    room.pot = 0;
    sendState(room);
  });

  socket.on("disconnect", () => {
    const room = getRoomFor(socket);
    if (!room) return;
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx >= 0) room.players[idx].connected = false;
    room.status = "waiting";
    room.message = "상대 연결이 끊겼습니다. 다시 접속해 주세요.";
    sendState(room);
    // 연결이 끊긴 플레이어는 방을 잠시 유지하지 않고 정리
    setTimeout(() => {
      const current = rooms.get(room.code);
      if (current) {
        current.players = current.players.filter(p => p.connected);
        if (!current.players.length) rooms.delete(current.code);
        else { current.players[0].host = true; current.hostIndex = 0; current.status = "waiting"; current.message = "상대 연결이 끊겼습니다. 새 방을 만들거나 다시 초대해 주세요."; sendState(current); }
      }
    }, 15000);
  });
});

server.listen(PORT, () => console.log(`Seotda server listening on ${PORT}`));
