const dgram = require("dgram");
const WebSocket = require('ws');
const express = require('express');
const cors = require("cors");
require('dotenv').config();

const Redis = require("ioredis");

const udpSockets = {};
const udpClients = {};
const members = {};
const users = {};
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
    res.json({ udpSockets, members, udpClients, users });
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
const redis = new Redis({
  host: 'localhost',
  port: 6379,
  // password: 'redenes@234',
});
const publisher = new Redis({
  host: 'localhost',
  port: 6379,
  // password: 'redenes@234',
});
const subscriber = new Redis({
  host: 'localhost',
  port: 6379,
  // password: 'redenes@234',
});
const activeRedisSubscriptions = new Set();
subscriber.subscribe('servers');
subscriber.on("message", async (channel_id, data) => {
  if(channel_id == 'servers') {
    console.log("Global Redis Message", {channel_id, data});

    // tell every other server to connect to this server via udp
    return;
  }
  const {message, websocketId} = JSON.parse(data);
  console.log("Redis Message", {message, websocketId});
  if(message.connect) {
    users[websocketId] = {...message.connect, channel_id: null};
    members[channel_id] = [...(members[channel_id] || []).filter((port) => port != websocketId), websocketId];
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN && members[channel_id].includes(client.websocketId)) {
        if(client.websocketId != websocketId) {
          // client.send(JSON.stringify({...message, channel_id}));
          client.send(JSON.stringify({ channel_id, users_connected: members[channel_id].map((socketId) => users[socketId]) }));
        } else {
          client.send(JSON.stringify({ channel_id, users_connected: members[channel_id].map((socketId) => users[socketId]) }));
        }
      }
    });
  } else if (message.disconnect) {
    members[channel_id] = (members[channel_id] || []).filter((port) => port != websocketId);
    if(members[channel_id].length) {
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && members[channel_id].includes(client.websocketId) && client.websocketId != websocketId) {
          // client.send(JSON.stringify(message));
          client.send(JSON.stringify({ channel_id, users_connected: members[channel_id].map((socketId) => users[socketId]) }));
        }
      });
    } else {
      console.log("Unsubscribing, ", channel_id);
      await subscriber.unsubscribe(channel_id);
      activeRedisSubscriptions.delete(channel_id);
    }
  } else if(channel_id) {
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN && members[channel_id].includes(client.websocketId) && client.websocketId != websocketId) {
        client.send(JSON.stringify(message));
      }
    });
  }
});
wss.on('connection', async (socket, req) => {
  console.log('WebSocket User Connected', req.url);
  const queryParams = new URL(`http://localhost${req.url}`).searchParams;
  const websocketId = queryParams.get('websocket_id');
  socket.websocketId = websocketId; // TODO remove this line not needed
  try {
    udpSockets[websocketId].address();
  } catch ($e) {
    await createSocket(websocketId);
  }
  socket.on('message', async (message) => {
    message = message instanceof Buffer ? message.toString('utf-8') : message;
    try {
      message = JSON.parse(message);
      console.log("Websocket Message", message);
      if(message.connect) {
        const {channel_id} = message.connect;
        try {
          udpSockets[websocketId].address();
        } catch ($e) {
          await createSocket(websocketId);
        }
        await redis.sadd(channel_id, 'localhost:3002');
        await publisher.publish('servers', channel_id);
        if (!activeRedisSubscriptions.has(channel_id)) {
          await subscriber.subscribe(channel_id);
          activeRedisSubscriptions.add(channel_id);
        }
        await publisher.publish(channel_id, JSON.stringify({message, websocketId}));
      } else if(message.disconnect) {
        const {channel_id} = message.disconnect;
        publisher.publish(channel_id, JSON.stringify({message, websocketId}));
      } else {
        for (const key in message) {
          if (Object.prototype.hasOwnProperty.call(message, key)) {
            const {channel_id} = message[key];
            publisher.publish(channel_id, JSON.stringify({message, websocketId}));
          }
        }
      }
    } catch ($e) {
      console.log($e);
    }
  });
  socket.on('close', async () => {
    console.log('WebSocket User Disconnected', req.url);
    const channels = Object.keys(members);
    channels.forEach((channel_id) => {
      publisher.publish(channel_id, JSON.stringify({message: {disconnect: {...users[websocketId], channel_id}}, websocketId}));
    });
    udpSockets[websocketId] && udpSockets[websocketId].close();
    delete users[websocketId];
    // const relevantMembers = [];
    // channels.forEach((channel_id) => {
    //   relevantMembers.concat((members[channel_id] || []).filter(item => !relevantMembers.includes(item)));
    // });
    // wss.clients.forEach(async (client) => {
    //   if (client.readyState === WebSocket.OPEN && client.websocketId != websocketId && relevantMembers.includes(client.websocketId)) {
    //     await client.send(JSON.stringify({disconnect: users[websocketId] }));
    //   }
    // });
    // udpSockets[websocketId] && udpSockets[websocketId].close();
    // for(var channel_id in members) {
    //   members[channel_id] = (members[channel_id] || []).filter((port) => port != websocketId);
    // }
    // delete users[websocketId];
  });
});
function createSocket(p = 0) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.bind(p, () => {
      const {port} = (socket.address());
      p = port;
      let timeout = null;
      function reinitTimeout() {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          try {
            socket.close();
          } catch ($e) {
            console.log($e);
          }
        }, 30000);
      }
      udpSockets[port] = socket;
      console.log(`UDP Socket listening on port ${port}`);
      socket.on("message", (msg, rinfo) => {
        console.log(rinfo, msg.toString('utf-8'));
        reinitTimeout();
        try {
          const packet = JSON.parse(msg.toString('utf-8'));
          if (packet.channel_id && members[packet.channel_id]) {
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
          // console.error($e);
          udpClients[port] = rinfo;
        }
      });
      socket.on("close", () => {
        console.log(`UDP Socket on port ${port} closed`);
        delete udpSockets[port];
        delete udpClients[port];
        clearTimeout(timeout);
      });
      reinitTimeout();
      resolve({socket, port});
    });
  });
}
const socket = dgram.createSocket("udp4");
socket.bind(3002, () => {
  const {port} = socket.address();
  console.log('Socket bound to port '+port);
  socket.on('error', (err) => {
      console.error('Socket error:', err);
  });
  socket.on("message", (msg, rinfo) => {
    try {
      const data = JSON.parse(msg.toString('utf-8'));
      console.log({data, rinfo});
    } catch ($e) {
      console.error("Error ::: ", $e);
    }
  });
});