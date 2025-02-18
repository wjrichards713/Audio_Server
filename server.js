const dgram = require("dgram");
const fs = require('fs');
const WebSocket = require('ws');
const crypto = require('crypto');
const {OpusEncoder} = require('node-opus');
const express = require('express');
const cors = require("cors");
const wav = require('wav');
require('dotenv').config();

const udpSockets = {};
const udpClients = {};
const members = {};
const users = {};
const aesKey = Buffer.from('46dR4QR5KH7JhPyyjh/ZS4ki/3QBVwwOTkkQTdZQkC0=', 'base64'); // Use the same key as the server
const decoder = new OpusEncoder(48000, 1);
const wavWriter = new wav.FileWriter('output.wav', {
  channels: 1,        // Mono
  sampleRate: 48000,  // 48kHz sample rate
  bitDepth: 16        // 16-bit PCM
});

const app = express();
app.use(cors());
app.use(express.static('client'));
app.get("/audio-server-port", async (req, res) => {
  try {
    const {socket, port} = await createSocket();
    await socket.close();
    delete udpSockets[port];
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
app.get("/audio-server-connected-users", async (req, res) => {
  try {
    const {channel_id} = req.query;
    res.json(members[channel_id]);
  } catch (err) {
    res.json([]);
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
  socket.websocketId = websocketId;
  try {
    udpSockets[websocketId].address();
  } catch ($e) {
    await createSocket(websocketId);
  }

  socket.on('message', (message) => {
    console.log(message);
    message = message instanceof Buffer ? message.toString('utf-8') : message;
    try {
      message = JSON.parse(message);
      console.log(message);
      if(message.connect) {
        users[websocketId] = message.connect;
        const {channel_id} = message.connect;
        members[channel_id] = [...(members[channel_id] || []).filter((port) => port != websocketId), websocketId];
        const allConnectedUsers = [];
        wss.clients.forEach((client) => {
          console.log(client, client.readyState);
          if (client.readyState === WebSocket.OPEN) {
            allConnectedUsers.push(users[client.websocketId]);
          }
        });
        socket.send({ users_connected: allConnectedUsers });
        console.log("Send user_connected to ", socket.websocketId);
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send({ users_connected: allConnectedUsers });
            console.log("Send user_connected to ", client.websocketId);
          }
        });
      }
      if(message.disconnect) {
        delete users[websocketId];
        const {channel_id} = message.disconnect;
        members[channel_id] = (members[channel_id] || []).filter((port) => port != websocketId);
      }
      for (const key in message) {
        if (Object.prototype.hasOwnProperty.call(message, key)) {
          const {channel_id} = message[key];
          if(channel_id) {
            members[channel_id].forEach((memberSocketId)=>{
              wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN && client.websocketId == memberSocketId) {
                  client.send(JSON.stringify(message));
                }
              });
            })
          }
        }
      }
    } catch ($e) {
      console.log($e);
    }
  });
  socket.on('close', () => {
    console.log('WebSocket User Disconnected', req.url);
    // clearInterval(interval);
    udpSockets[websocketId] && udpSockets[websocketId].close();
    for(var channel_id in members) {
      members[channel_id] = (members[channel_id] || []).filter((port) => port != websocketId);
    }
    delete users[websocketId];
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
            // const base64Decoded = Buffer.from(packet.data, "base64");
            // const decryptedData = decryptAES(base64Decoded, aesKey);
            // const pcm = decoder.decode(decryptedData, 3840);
            // wavWriter.write(pcm);
            members[packet.channel_id].forEach((p) => {
              if(p != port && udpSockets[p] && udpClients[p]) {
              // if(udpSockets[p]) {
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

function decryptAES(encryptedData, key) {
  const iv = encryptedData.slice(0, 12); // Extract IV (first 12 bytes)
  const encryptedPayload = encryptedData.slice(12, -16); // Extract encrypted data (excluding last 16 bytes)
  const authTag = encryptedData.slice(-16); // Extract last 16 bytes as auth tag
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag); // Set authentication tag
  const decrypted = Buffer.concat([decipher.update(encryptedPayload), decipher.final()]);
  return decrypted;
}

setInterval(() => {
  console.log({ udpSockets, members, udpClients });
}, 10000);