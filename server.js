const dgram = require("dgram");
const fs = require('fs');
const WebSocket = require('ws');
const crypto = require('crypto'); // For AES decryption
const OpusScript = require('opusscript');
const express = require('express');
const cors = require("cors");
require('dotenv').config();

const udpSockets = {};
const udpClients = {};
const members = {};

const app = express();
app.use(cors());
app.use(express.static('client'));
app.get("/audio-server-port", async (req, res) => {
  try {
    const {socket, port} = await createSocket();
    await socket.close();
    res.json({
      udp_port: port,
      websocket_id: port,
      aes_key: "eyJhbGciOiJIUzI1eyJhbGciOiJIUzI1eyJhbGciOiJIUzI1"
    });
  } catch (err) {
    console.error("Error getting available port:", err);
    res.status(500).json({ error: "Failed to retrieve an available port." });
  }
});
app.listen(3000, () => {
  console.log(`Express API running on http://localhost:3000`);
});

const wss = new WebSocket.Server({ port: 3001 }, () => {
  console.log('WebSocket server started on ws://localhost:3001');
});
wss.on('connection', async (socket, req) => {
  console.log('WebSocket User Connected', req.url);
  const queryParams = new URL(`http://localhost${req.url}`).searchParams;
  const websocketId = queryParams.get('websocket_id');

  try {
    udpSockets[websocketId].address();
  } catch ($e) {
    await createSocket(websocketId);
  }

  socket.on('message', (message) => {
    message = message instanceof Buffer ? message.toString('utf-8') : message;
    try {
      message = JSON.parse(message);
      if(message.connect) {
        const {channel_id} = message.connect;
        members[channel_id] = [...(members[channel_id] || []).filter((port) => port != websocketId), websocketId];
      }
      if(message.disconnect) {
        const {channel_id} = message.disconnect;
        members[channel_id] = (members[channel_id] || []).filter((port) => port != websocketId);
      }
    } catch ($e) {
      if(message == 'ping') {
        socket.send("pong");
      }
    }
  });
  socket.on('close', () => {
    console.log('WebSocket User Disconnected', req.url);
    udpSockets[websocketId] && udpSockets[websocketId].close();
    for(var channel_id in members) {
      members[channel_id] = (members[channel_id] || []).filter((port) => port != websocketId);
    }
    delete udpSockets[websocketId];
    delete udpClients[websocketId];
  });
});

function createSocket(p = 0) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.bind(p, () => {
      const {port} = (socket.address());
      udpSockets[port] = socket;
      console.log(`UDP Socket listening on port ${port}`);
      socket.on("message", (msg, rinfo) => {
        console.log(rinfo, msg.toString('utf-8'));
        try {
          const packet = JSON.parse(msg.toString('utf-8'));
          if (packet.channel_id && members[packet.channel_id]) {
            members[packet.channel_id].forEach((p) => {
              if(p != port && udpSockets[p]) {
                udpSockets[p].send(msg, udpClients[p].port, udpClients[p].address, (err) => {
                  if (err) {
                    console.error(`Failed to send to ${udpClients[p].address}:${udpClients[p].port}`, err);
                  } else {
                    console.log(`Forwarded packet to ${udpClients[p].address}:${udpClients[p].port}`);
                  }
                });
              }
            });
          }
          udpClients[port] = rinfo;
        } catch ($e) {
          console.error($e);
          udpClients[port] = rinfo;
        }
      });
      resolve({socket, port});
    });
  });
}

setInterval(() => {
  console.log({ udpSockets, members, udpClients });
}, 10000);