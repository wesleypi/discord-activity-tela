import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";
dotenv.config({ path: "../.env" });

const app = express();
const port = 3001;

// Allow express to parse JSON bodies
app.use(express.json());

app.post("/api/token", async (req, res) => {

  // Exchange the code for an access_token
  const response = await fetch(`https://discord.com/api/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: process.env.VITE_DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code: req.body.code,
    }),
  });

  // Retrieve the access_token from the response
  const { access_token } = await response.json();

  // Return the access_token to our client as { access_token: "..."}
  res.send({access_token});
});

const server = app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});

// Screen relay: the Discord proxy only supports WebSockets (no WebRTC), so
// the sharer's recorded video chunks are forwarded to everyone else in the
// room (one room per Activity instance)
const rooms = new Map(); // room -> { clients: Map<id, { ws, name }>, sharerId }
const wss = new WebSocketServer({ server, path: "/api/ws" });

wss.on("connection", (ws, req) => {
  const params = new URL(req.url, "http://localhost").searchParams;
  const roomId = params.get("room");
  const id = params.get("id");
  const name = params.get("name") || id;
  if (!roomId || !id) return ws.close();

  if (!rooms.has(roomId)) rooms.set(roomId, { clients: new Map(), sharerId: null });
  const room = rooms.get(roomId);

  const broadcast = (data, isBinary = false) => {
    for (const [otherId, other] of room.clients) {
      if (otherId !== id) other.ws.send(isBinary ? data : JSON.stringify(data), { binary: isBinary });
    }
  };

  ws.send(JSON.stringify({
    type: "peers",
    peers: [...room.clients].map(([peerId, c]) => ({ id: peerId, name: c.name })),
    sharerId: room.sharerId,
  }));
  room.clients.set(id, { ws, name });
  broadcast({ type: "peer-joined", id, name });
  console.log(`[${roomId}] ${name} joined (${room.clients.size} in room)`);

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      // Only the current sharer's video chunks are relayed
      if (room.sharerId === id) broadcast(data, true);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type === "stream-start") {
      room.sharerId = id;
      broadcast({ type: "stream-start", id, mime: msg.mime });
    } else if (msg.type === "stream-stop" && room.sharerId === id) {
      room.sharerId = null;
      broadcast({ type: "stream-stop", id });
    }
  });

  ws.on("close", () => {
    room.clients.delete(id);
    if (room.sharerId === id) room.sharerId = null;
    broadcast({ type: "peer-left", id });
    if (room.clients.size === 0) rooms.delete(roomId);
    console.log(`[${roomId}] ${name} left`);
  });
});
