const dgram = require("dgram");
const WebSocket = require('ws');
const express = require('express');
const cors = require("cors");
const https = require('https');
const os = require('os');
const Redis = require("ioredis");
require('dotenv').config();

// Promise-based HTTP request to get public IP
const getPublicIP = () => {
  return new Promise((resolve, reject) => {
    https.get('https://api.ipify.org', (response) => {
      let data = '';
      response.on('data', (chunk) => {
        data += chunk;
      });
      response.on('end', () => {
        resolve(data.trim());
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
};

// Store server's public IP
let serverPublicIP = null;
// Initialize server's public IP at startup
(async () => {
  try {
    serverPublicIP = await getPublicIP();
    console.log(`Server's public IP initialized: ${serverPublicIP}`);
  } catch (err) {
    console.error("Failed to initialize server's public IP:", err);
    // Use a fallback or let services fail gracefully
  }
})();

// Global data structures for managing connections and server state
const udpSockets = {}; // Stores UDP sockets indexed by user's websocket ID, eg: { 33055: Socket }
const udpClients = {}; // Stores UDP client information (rinfo) indexed by user's websocket ID  { 33055: { port: 15000, address: 129.126.11.134 } }
const servers = {}; // Tracks which servers are handling each channel { 555: ["35.90.120.85:3002"] }
const members = {}; // Maps channel IDs to arrays of websocket IDs of connected users { 555: ["33055"] } of this server only
const patches = {}; // Maps Pacthes like { 555: [555, 666] }

const app = express(); // Express application instance
app.use(cors());
app.use(express.static('client'));
app.get("/audio-server-connected-users", async (req, res) => {
  try {
    const keys = await redis.keys("member_*");
    const users = {};
    for (const key of keys) {
      const channel_id = key.replace("member_", "");
      const entries = await redis.hgetall(key);
      const parsedEntries = Object.entries(entries).map(([socketId, value]) => ({
        socketId,
        channel_id,
        ...JSON.parse(value)
      }));
      users[channel_id] = parsedEntries;
    }
    res.json({ udpSockets, members, udpClients, users, servers, patches, ip: serverPublicIP });
  } catch (err) {
    res.json([]);
  }
});
// Add these routes to your Express app

// Middleware to parse JSON requests
app.use(express.json());

// GET all channels
app.get("/channels", async (req, res) => {
  try {
    const channels = await redis.hgetall('channels');
    res.json(Object.fromEntries(
      Object.entries(channels).map(([id, data]) => [id, JSON.parse(data)])
    ));
  } catch (err) {
    console.error("Error fetching channels:", err);
    res.status(500).json({ error: "Failed to retrieve channels" });
  }
});

// GET a single channel
app.get("/channels/:channelId", async (req, res) => {
  try {
    const { channelId } = req.params;
    const channel = await getChannel(channelId);
    
    if (!channel) {
      return res.status(404).json({ error: "Channel not found" });
    }
    
    res.json(channel);
  } catch (err) {
    console.error("Error fetching channel:", err);
    res.status(500).json({ error: "Failed to retrieve channel" });
  }
});

// CREATE or UPDATE a channel
app.post("/channels", async (req, res) => {
  try {
    let channels = [];
    if (Array.isArray(req.body)) {
      // Validate each object in the array
      for (const ch of req.body) {
        if (!ch?.channel_id) {
          return res.status(400).json({ error: "Missing required channel_id in one or more objects" });
        }
        channels.push(ch);
      }
    } else if (req.body?.channel_id) {
      channels.push(req.body);
    } else {
      return res.status(400).json({ error: "Missing required channel_id field" });
    }
    const redisMap = {};
    for (const ch of channels) {
      redisMap[ch.channel_id.toString()] = JSON.stringify(ch);
    }
    await redis.hset('channels', redisMap);
    res.status(201).json({
      message: "Channel(s) created/updated successfully",
      channels: channels
    });
  } catch (err) {
    console.error("Error creating/updating channel:", err);
    res.status(500).json({ error: "Failed to create/update channel(s)" });
  }
});

// DELETE a channel
app.delete("/channels/:channelId", async (req, res) => {
  try {
    const { channelId } = req.params;
    
    // Check if channel exists first
    const channel = await getChannel(channelId);
    if (!channel) {
      return res.status(404).json({ error: "Channel not found" });
    }
    
    // Delete the channel
    await redis.hdel('channels', channelId);
    
    res.json({ 
      message: "Channel deleted successfully",
      channelId 
    });
  } catch (err) {
    console.error("Error deleting channel:", err);
    res.status(500).json({ error: "Failed to delete channel" });
  }
});

// Endpoint for CPU and RAM usage
app.get('/system-stats', (req, res) => {
  const memoryUsage = {
    total: (os.totalmem() / 1024 / 1024).toFixed(2) + ' MB',
    free: (os.freemem() / 1024 / 1024).toFixed(2) + ' MB',
    used: ((os.totalmem() - os.freemem()) / 1024 / 1024).toFixed(2) + ' MB',
    usagePercent: ((1 - os.freemem() / os.totalmem()) * 100).toFixed(2) + '%'
  };
  
  res.json({
    cpu: function getCpuInfo() {
      const cpus = os.cpus();
      return cpus.map((core, index) => {
        const total = Object.values(core.times).reduce((acc, tv) => acc + tv, 0);
        const usage = ((total - core.times.idle) / total) * 100;

        return {
          core: index,
          model: core.model,
          speed: core.speed,
          usage: usage.toFixed(2) + '%'
        };
      });
    }(),
    memory: memoryUsage,
    uptime: os.uptime() + ' seconds'
  });
});
app.get('/health', (req, res) => {
  res.json(serverPublicIP);
})
app.listen(3000, () => {
  console.log(`Express API running on http://localhost:3000`);
});

const wss = new WebSocket.Server({ port: 3001 }, () => {
  console.log('WebSocket server started on ws://localhost:3001');
});
const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  password: process.env.REDIS_PASS,
});
const publisher = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  password: process.env.REDIS_PASS,
});
const subscriber = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  password: process.env.REDIS_PASS,
});
const redis_channel_subscriptions = new Set();

subscriber.subscribe('server_channel_sync');
subscriber.subscribe('patchings');

redis.on('ready', async () => {
  const raw = await redis.get('patches');
  if (raw) {
    const parsed = JSON.parse(raw);
    Object.assign(patches, parsed);
  }
  const keys = await redis.keys('*');
  serverPublicIP = await getPublicIP();
  for (const key of keys) {
    if (key.endsWith('_servers')) {
      const members = await redis.smembers(key);
      for (const member of members) {
        if (member.startsWith(serverPublicIP)) {
          await redis.srem(key, member);
          console.log(`Removed ${member} from ${key}`);
          await publisher.publish('server_channel_sync', key.replace("_servers", ''));
        }
      }
    }
    if (key.endsWith('_members')) {
      const members = await redis.hgetall(key);
      for (const field in members) {
        if (field.startsWith(serverPublicIP)) {
          await redis.hdel(key, field);
          console.log(`Removed ${field} from ${key}`);
        }
      }
    }
  }
});

subscriber.on("message", async (event_name, data) => {
  switch (event_name) {
    case 'server_channel_sync': {
      const channel_id = data;
      const channel_servers = await redis.smembers(`${channel_id}_servers`);
      if(channel_servers && channel_servers.length) {
        servers[channel_id] = channel_servers;
      } else {
        delete servers[channel_id];
      }
      return;
    }
    case 'patchings': {
      const { type, channels } = JSON.parse(data);
      if(type == 'PATCH') {
        channels.forEach(async (channel) => {
          patches[channel] = Array.from(new Set([
            ...(patches[channel] || []),
            ...channels
          ]));
        });
        const users_connected = [...new Set((await Promise.all(channels.map(async (ch) => (await redis.hvals(`${ch}_members`)).map(JSON.parse)))).flat())];
        wss.clients.forEach((client) => {
          channels.forEach((channel_id) => {
            if(client.readyState === WebSocket.OPEN && (members[channel_id] || []).includes(client.websocketId)) {
              client.send(JSON.stringify({ channel_id, users_connected: users_connected }));
            }
          });
        });
      } else if (type == 'UNPATCH') {
        channels.forEach(async (channel) => {
          const filtered = Array.from(new Set(
            (patches[channel] || []).filter(c => !channels.includes(c) || c === channel)
          ));
          if (filtered.length > 0) {
            patches[channel] = filtered;
            const users_connected = [...new Set((await Promise.all(patches[channel].map(async (ch) => (await redis.hvals(`${ch}_members`)).map(JSON.parse)))).flat())];
            wss.clients.forEach((client) => {
              patches[channel].forEach((channel_id) => {
                if(client.readyState === WebSocket.OPEN && (members[channel_id] || []).includes(client.websocketId)) {
                  client.send(JSON.stringify({ channel_id, users_connected: users_connected }));
                }
              });
            });
          } else {
            delete patches[channel];
          }
        });
        
      }
      redis.set('patches', JSON.stringify(patches));
      return;
    }
    default: {
      const channel_id = event_name;
      const {message, websocketId} = JSON.parse(data);
      if(message.connect) {
        // const users_connected = [...new Set((await redis.hvals(`${channel_id}_members`)).map(JSON.parse))];
        const users_connected = [...new Set((await Promise.all((patches[channel_id] || [channel_id]).map(async (ch) => (await redis.hvals(`${ch}_members`)).map(JSON.parse)))).flat())];
        wss.clients.forEach((client) => {
          if(client.readyState === WebSocket.OPEN && (members[channel_id] || []).includes(client.websocketId)) {
            if(client.websocketId != websocketId) {
              client.send(JSON.stringify({ channel_id, users_connected: users_connected }));
            } else {
              client.send(JSON.stringify({ channel_id, users_connected: users_connected }));
            }
          }
        })
        return;
      }
      if(message.disconnect) {
        if((members[channel_id] || []).length) {
          // const users_connected = [...new Set((await redis.hvals(`${channel_id}_members`)).map(JSON.parse))];
          const users_connected = [...new Set((await Promise.all((patches[channel_id] || [channel_id]).map(async (ch) => (await redis.hvals(`${ch}_members`)).map(JSON.parse)))).flat())];
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN && (members[channel_id] || []).includes(client.websocketId) && client.websocketId != websocketId) {
              client.send(JSON.stringify({ channel_id, users_connected: users_connected }));
            }
          });
        } else {
          console.log("Unsubscribing, ", channel_id);
          await redis.srem(`${channel_id}_servers`, `${serverPublicIP}:3002`);
          await subscriber.unsubscribe(channel_id);
          await publisher.publish('server_channel_sync', channel_id);
          redis_channel_subscriptions.delete(channel_id);
          delete members[channel_id];
        }
      } else {
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN && (members[channel_id] || []).includes(client.websocketId) && client.websocketId != websocketId) {
            client.send(JSON.stringify(message));
          }
        });
      }
    }
  }
});

const getChannel = async (id) => JSON.parse(await redis.hget('channels', id) || 'null');

wss.on('connection', async (socket, req) => {
  console.log('WebSocket User Connected', req.url);
  try {
    serverPublicIP = await getPublicIP();
  } catch ($e) {
    console.error("Error detecting public IP:", $e);
    socket.close();
    return;
  }
  const {socket: udpSocket, port: websocketId} = await createSocket();
  socket.websocketId = websocketId;
  setInterval(() => {
    socket.send([]);
  }, 50000);
  socket.send(JSON.stringify({
    udp_port: websocketId,
    udp_host: serverPublicIP,
    websocket_id: websocketId,
    aes_key: "N/A"
  }));
  try {
    udpSockets[websocketId].address();
  } catch ($e) {
    await createSocket(websocketId);
  }
  socket.on('message', async (message) => {
    message = message instanceof Buffer ? message.toString('utf-8') : message;
    console.log("WSS:", message);
    try {
      message = JSON.parse(message);
      if(message.connect) {
        const { channel_id } = message.connect;
        delete message.connect.channel_id;
        if(!await getChannel(channel_id)) {
          console.log(`User ${websocketId} tried to connect to ${channel_id} but channel is not yet registered`);
          socket.send(JSON.stringify({
            error: true,
            message: `Channel ${channel_id} does not exist`,
            code: "CHANNEL_NOT_FOUND"
          }));
          return;
        }
        try {
          udpSockets[websocketId].address();
        } catch ($e) {
          await createSocket(websocketId);
        }
        members[channel_id] = [...(members[channel_id] || []).filter((port) => port != websocketId), websocketId];
        await redis.hset(`${channel_id}_members`, `${serverPublicIP}:${websocketId}`, JSON.stringify(message.connect));
        await redis.sadd(`${channel_id}_servers`, `${serverPublicIP}:3002`);
        await publisher.publish('server_channel_sync', channel_id);
        if (!redis_channel_subscriptions.has(channel_id)) {
          await subscriber.subscribe(channel_id);
          redis_channel_subscriptions.add(channel_id);
        }
        (patches[channel_id] || [channel_id]).forEach(async (channel_id) => {
          await publisher.publish(channel_id, JSON.stringify({message, websocketId}));
        })
      } else if(message.disconnect) {
        const { channel_id } = message.disconnect;
        members[channel_id] = (members[channel_id] || []).filter((port) => port != websocketId);
        await redis.hdel(`${channel_id}_members`, `${serverPublicIP}:${websocketId}`);
        (patches[channel_id] || [channel_id]).forEach(async (channel_id) => {
          if (message?.channel_id) {message.channel_id = channel_id;}
          Object.values(message).forEach(obj => { if (obj?.channel_id) { obj.channel_id = channel_id; } });
          await publisher.publish(channel_id, JSON.stringify({message, websocketId}));
        })
      } else {
        for (const key in message) {
          if (Object.prototype.hasOwnProperty.call(message, key)) {
            const {channel_id} = message[key];
            (patches[channel_id] || [channel_id]).forEach(async (channel_id) => {
              if (message?.channel_id) {message.channel_id = channel_id;}
              Object.values(message).forEach(obj => { if (obj?.channel_id) { obj.channel_id = channel_id; } });
              await publisher.publish(channel_id, JSON.stringify({message, websocketId}));
            })
          }
        }
      }
    } catch ($e) {
      console.log($e);
    }
  });
  socket.on('close', async (e) => {
    console.log('WebSocket User Disconnected', req.url, e);
    const channels = Object.keys(members);
    channels.forEach(async (channel_id) => {
      if(members[channel_id].includes(websocketId)) {
        members[channel_id] = (members[channel_id] || []).filter((port) => port != websocketId);
        const user = JSON.parse(await redis.hget(`${channel_id}_members`, `${serverPublicIP}:${websocketId}`));
        await redis.hdel(`${channel_id}_members`, `${serverPublicIP}:${websocketId}`);
        publisher.publish(channel_id, JSON.stringify({message: {disconnect: {...user, channel_id}}, websocketId}));
      }
    });
    udpSockets[websocketId] && udpSockets[websocketId].close();
  });
});

const machineSocket = dgram.createSocket("udp4");
machineSocket.bind(3002, () => {
  const {port} = machineSocket.address();
  console.log(`Server Listening for InterConnected Servers on UDP ${port}`);
  machineSocket.on('error', console.error);
  machineSocket.on("message", (data, rinfo) => {
    try {
      const {packet, port} = JSON.parse(data.toString('utf-8'));
      if (packet.channel_id && members[packet.channel_id]) {
        members[packet.channel_id].forEach((p) => {
          if(udpSockets[p] && udpClients[p]) {
            udpSockets[p].send(JSON.stringify(packet), udpClients[p].port, udpClients[p].address, (err) => {
              if (err) {
                console.error(`Failed to send to ${udpClients[p].address}:${udpClients[p].port}`, err);
              } else {
                // console.log(`Forwarded packet to ${udpClients[p].address}:${udpClients[p].port}`);
              }
            });
          }
        });
      }
    } catch ($e) {
      console.log($e);
    }
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
            console.error($e);
          }
        }, 30000);
      }
      udpSockets[port] = socket;
      console.log(`UDP Socket listening on port ${port}`);
      socket.on("message", (msg, rinfo) => {
        // console.log(`Received Packet from ${port}`);
        reinitTimeout();
        udpClients[port] = rinfo;
        try {
          const packet = JSON.parse(msg.toString('utf-8'));
          if (packet.channel_id && servers[packet.channel_id] && servers[packet.channel_id].length) {
            const channels = patches[packet.channel_id] || [packet.channel_id];
            channels.forEach((channel) => {
              packet.channel_id = channel;
              (servers[packet.channel_id] || []).forEach((server_address) => {
                if(server_address === `${serverPublicIP}:3002`) {
                  members[packet.channel_id].forEach((p) => {
                    if(p != port && udpSockets[p] && udpClients[p]) {
                      udpSockets[p].send(JSON.stringify(packet), udpClients[p].port, udpClients[p].address, (err) => {
                        if (err) {
                          console.error(`Failed to send to ${udpClients[p].address}:${udpClients[p].port}`, err);
                        } else {
                          // console.log(`Forwarded Packet to ${udpClients[p].address}:${udpClients[p].port}`);
                        }
                      });
                    }
                  });
                } else {
                  const [ip, p] = server_address.split(":");
                  machineSocket.send(JSON.stringify({packet, port}), p, ip, (err) => {
                    if (err) {
                      console.error(`Failed to send to ${ip}:${p}`, err);
                    } else {
                      // console.log(`Forwarded Packet to ${ip}:${p}`);
                    }
                  })
                }
              });
            })
          }
        } catch ($e) { console.log($e); }
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

app.post("/channels/patch", async (req, res) => {
  const { channels  } = req.body;
  if (!channels || channels.length < 2 ) {
    return res.status(400).json({ error: "Provide at least two channels." });
  }
  try {
    publisher.publish('patchings', JSON.stringify({type: 'PATCH', channels}));
    res.json({ message: "Channels patched successfully." });
  } catch (err) {
    console.error("Patch error:", err);
    res.status(500).json({ error: "Patch failed." });
  }
});
app.post("/channels/unpatch", async (req, res) => {
  const { channels } = req.body;
  if (!Array.isArray(channels) || channels.length === 0) {
    return res.status(400).json({ error: "Provide channels to unmerge." });
  }
  try {
    publisher.publish('patchings', JSON.stringify({type: 'UNPATCH', channels}));
    res.json({ message: "Channels unpatched successfully." });
  } catch (err) {
    console.error("Unmerge error:", err);
    res.status(500).json({ error: "Failed to unmerge." });
  }
});
app.get("/patches", async (req, res) => {
  res.json(patches);
});