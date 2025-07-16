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
const members = {}; // Maps channel IDs to arrays of websocket IDs of connected users { 555: ["33055"] }

const app = express(); // Express application instance
app.use(cors());
app.use(express.static('client'));
app.get("/audio-server-port", async (req, res) => {
  try {
    // Get server's public IP address
    let host;
    
    // Use cached IP or fetch a new one
    if (serverPublicIP) {
      host = serverPublicIP;
    } else {
      try {
        host = await getPublicIP();
        serverPublicIP = host; // Cache the IP for future use
        // console.log(`Detected public IP: ${host}`);
      } catch (ipError) {
        console.error("Error detecting public IP:", ipError);
        // If external service fails, use a placeholder and let client know
        host = 'auto'; // Special value indicating client should auto-detect
      }
    }
    
    const {socket, port} = await createSocket();
    await socket.close();
    delete udpSockets[port];
    console.log("Response sent to a requesting client", {
      udp_port: port,
      udp_host: host,
      websocket_id: port,
      aes_key: "eyJhbGciOiJIUzI1eyJhbGciOiJIUzI1eyJhbGciOiJIUzI1"
    });
    res.json({
      udp_port: port,
      udp_host: host,
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
    res.json({ udpSockets, members, udpClients, users, servers });
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
    
    // Parse the JSON values in the hash
    const parsedChannels = {};
    for (const [channelId, channelData] of Object.entries(channels)) {
      parsedChannels[channelId] = JSON.parse(channelData);
    }
    
    res.json(parsedChannels);
  } catch (err) {
    console.error("Error fetching channels:", err);
    res.status(500).json({ error: "Failed to retrieve channels" });
  }
});
app.get('/patched-groups', (req, res) => {
  res.json({ groups: patchedGroups });
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
    const channelData = req.body;
    // console.log("🚀 ~ app.post ~ channelData:", channelData)
    
    if (!channelData || !channelData.channel_id) {
      return res.status(400).json({ error: "Missing required channel_id field" });
    }
    
    const channelId = channelData.channel_id.toString();
    
    // Store the channel data
    await redis.hset('channels', { [channelId]: JSON.stringify(channelData) });
    
    res.status(201).json({ 
      message: "Channel created/updated successfully",
      channel: channelData 
    });
  } catch (err) {
    console.error("Error creating/updating channel:", err);
    res.status(500).json({ error: "Failed to create/update channel" });
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
  res.json(true);
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
const activeRedisSubscriptions = new Set();
let patchedGroups =[];
let patchedChannelSet = new Set(); // Tracks all channels that are currently patched

(async () => {
  try {
    const groupData = await redis.get("patched_groups");
    if (groupData) {
      patchedGroups = JSON.parse(groupData);
    }
    // console.log("🚀 ~ patchedGroups:", patchedGroups)

    const channels = await redis.smembers("patched_channel_set");
    if (channels && channels.length > 0) {
      patchedChannelSet = new Set(channels);
    }

    // console.log("✅ Patched data loaded from Redis:", patchedGroups);
  } catch (err) {
    console.error("❌ Failed to load patched data from Redis:", err);
  }
})();


subscriber.subscribe('servers');
subscriber.subscribe('patched_info');

subscriber.on("message", async (channel_id, data) => {
  if(channel_id == 'servers') {
    // console.log("Global Redis Message", {channel_id, data});
    const channel_servers = await redis.smembers("server_"+data);
    if(channel_servers && channel_servers.length) {
      servers[data] = channel_servers;
    } else {
      delete servers[data];
    }
    return;
  }

  if (channel_id == 'patched_info') {
    const groupData = await redis.get("patched_groups");
    if (groupData) {
      patchedGroups = JSON.parse(groupData);
    }
    // console.log("🚀 ~ patchedGroups:", patchedGroups)
    const {type,channels}  = JSON.parse(data);
    const sortedNew = [...channels].sort();
    if(type==="PATCH"){
      const users_connected_set = new Set();
      for (const ch of sortedNew) {
        const memberData = await redis.hvals("member_" + ch);
        // console.log("🚀 ~ subscriber.on ~ memberData:", memberData)
        memberData.map(JSON.parse).forEach(item => users_connected_set.add(item.user_name));
      }
      const users_connected = [...users_connected_set];
      // console.log("🚀 ~ subscriber.on ~ users_connected:", users_connected)
      for (const ch of sortedNew) {
        if (members[ch]) {
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN && members[ch].includes(client.websocketId)) {
              client.send(JSON.stringify({ channel_id: ch, users_connected:  users_connected }));
            }
          });
        }
      }
      // console.log("Added new patched group:", sortedNew);

    }else if (type === "UNPATCH") {
      // Remove group
      for (const ch of sortedNew) {
        const users = new Set();
        const memberData = await redis.hvals("member_" + ch);
        memberData.map(JSON.parse).forEach(item => users.add(item.user_name));
        const users_connected = [...users];
    
        if (members[ch]) {
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN && members[ch].includes(client.websocketId)) {
              client.send(JSON.stringify({
                channel_id: ch,
                users_connected : users_connected, // only users of this specific channel
              }));
            }
          });
        }
      }
      // console.log("Removed patched group:", sortedNew);
    }
    return;
  }

  const {message, websocketId} = JSON.parse(data);
  // console.log("Redis Message", {message, websocketId});

  let targetChannels = [channel_id];
  // 2. Check if it's part of a patched group
  for (const group of patchedGroups) {
    if (group.includes(channel_id)) {
      targetChannels = group;
      break; // Exit loop once the group is found
    }
  }
  const users_connected_set = new Set();
  for (const ch of targetChannels) {
    patchedChannelSet.add(ch);
    const memberData = await redis.hvals("member_" + ch);
    // console.log("🚀 ~ subscriber.on ~ memberData:", memberData)
    memberData.map(JSON.parse).forEach(item => users_connected_set.add(item.user_name));
  }
  const users_connected = [...users_connected_set];
  if(message.connect) {
    // const users_connected = [...new Set((await redis.hvals("member_" + channel_id)).map(JSON.parse).map(item => item.user))];
    for (const ch of targetChannels) {
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && members[ch]?.includes(client.websocketId)) {
          if(client.websocketId != websocketId) {
            // client.send(JSON.stringify({...message, channel_id}));
            client.send(JSON.stringify({ ch, users_connected: users_connected }));
          } else {
            client.send(JSON.stringify({ ch, users_connected: users_connected }));
          }
        }
      });
    }
  } else if (message.disconnect) {
      for (const ch of targetChannels) {
        if(members[ch]) {
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN && members[ch]?.includes(client.websocketId) && client.websocketId != websocketId) {
              // client.send(JSON.stringify(message));
              client.send(JSON.stringify({ channel_id, users_connected: users_connected }));
            }
          });
        } else {
          // console.log("Unsubscribing, ", channel_id);
          const serverAddress = `${serverPublicIP}:3002`; // 3002 is the machine socket port
          await redis.srem("server_"+channel_id, serverAddress);
          await subscriber.unsubscribe(channel_id);
          await publisher.publish('servers', channel_id);
          activeRedisSubscriptions.delete(channel_id);
          delete members[channel_id];
        }
      }
    } else if(channel_id) {
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN && members[channel_id]?.includes(client.websocketId) && client.websocketId != websocketId) {
        client.send(JSON.stringify(message));
      }
    });
  }
});
async function getChannel(channelId) {
  const raw = await redis.hget('channels', channelId);
  return raw ? JSON.parse(raw) : null;
}
async function savePatchedDataToRedis() {
  await redis.set("patched_groups", JSON.stringify(patchedGroups));
  await redis.del("patched_channel_set");
  if (patchedChannelSet.size > 0) {
    await redis.sadd("patched_channel_set", [...patchedChannelSet]);
  }
}

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
      // console.log("Websocket Message", message);

      if(message.connect) {
        const {channel_id} = message.connect;
        if(!await getChannel(channel_id)) {
          // console.log("channel not got");
          return;
        }
        // console.log("got channel");
        try {
          udpSockets[websocketId].address();
        } catch ($e) {
          await createSocket(websocketId);
        }
        members[channel_id] = [...(members[channel_id] || []).filter((port) => port != websocketId), websocketId]; // update members to have new user added, members contains socket ids of this server only
        // Use the server's public IP address instead of AUDIOSERVER_ADDR
        // console.log("-------------",members[channel_id] )
        const serverAddress = `${serverPublicIP}:3002`; // 3002 is the machine socket port
        await redis.hset("member_" + channel_id, `${serverPublicIP}:${websocketId}`, JSON.stringify(message.connect));
        await redis.sadd("server_" + channel_id, serverAddress);
        await publisher.publish('servers', channel_id); // inform all servers about the update has been made
        if (!activeRedisSubscriptions.has(channel_id)) {
          await subscriber.subscribe(channel_id);
          activeRedisSubscriptions.add(channel_id);
        }
        await publisher.publish(channel_id, JSON.stringify({message, websocketId})); // broadcast the message as it is to all servers, so other clients will get it

      } else if(message.disconnect) {
        const {channel_id} = message.disconnect;
        members[channel_id] = (members[channel_id] || []).filter((port) => port != websocketId);
        await redis.hdel(
          "member_" + channel_id,
          `${serverPublicIP}:${websocketId}`
        );
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
  socket.on('close', async (e) => {
    console.log('WebSocket User Disconnected', req.url, e);
    const channels = Object.keys(members);
    channels.forEach(async (channel_id) => {
      if(members[channel_id].includes(websocketId)) {
        members[channel_id] = (members[channel_id] || []).filter((port) => port != websocketId);
        const user = JSON.parse(await redis.hget("member_" + channel_id, `${serverPublicIP}:${websocketId}`));
        await redis.hdel(
          "member_" + channel_id,
          `${serverPublicIP}:${websocketId}`
        );
        publisher.publish(channel_id, JSON.stringify({message: {disconnect: {...user, channel_id}}, websocketId}));
      }
    });
    udpSockets[websocketId] && udpSockets[websocketId].close();
  });
});
const machineSocket = dgram.createSocket("udp4");
machineSocket.bind(3002, () => {
  const {port} = machineSocket.address();
  // console.log('Socket bound to port '+port);
  machineSocket.on('error', (err) => {
      console.error('Socket error:', err);
  });
  machineSocket.on("message", (data, rinfo) => {
    try {
      const {packet, port} = JSON.parse(data.toString('utf-8'));
      if (packet.channel_id && members[packet.channel_id]) {
        // console.log(packet, port, members[packet.channel_id]);
        // console.log("🚀 ~ mebers[packet.channel_id].forEmach ~   members[packet.channel_id]:",   members[packet.channel_id])

        members[packet.channel_id].forEach((p) => {
          // console.log("🚀 ~ machineSocket.on ~ packet, port:", p ,packet, port)

          if(p != port && udpSockets[p] && udpClients[p]) {
          // if(udpSockets[p]) {

            udpSockets[p].send(JSON.stringify(packet), udpClients[p].port, udpClients[p].address, (err) => {
              if (err) {
                // console.error(`Failed to send to ${udpClients[p].address}:${udpClients[p].port}`, err);
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
            console.log($e);
          }
        }, 30000);
      }
      udpSockets[port] = socket;
      console.log(`UDP Socket listening on port ${port}`);
      socket.on("message", (msg, rinfo) => {
        console.log("UDP Message received from:" , rinfo);
        reinitTimeout();
        udpClients[port] = rinfo;
        try {
          const packet = JSON.parse(msg.toString('utf-8'));
          if (packet.channel_id ) {
            let targetChannels = [packet.channel_id];

            // 2. Check if it's part of a patched group
            for (const group of patchedGroups) {
              if (group.includes(packet.channel_id)) {
                targetChannels = group;
                break; // Exit loop once the group is found
              }
            }
            // console.log("🚀 ~ socket.on ~ patchedGroups:", patchedGroups)

            // console.log("🚀 ~ socket.on ~ targetChannels:", targetChannels)

            // 3. Iterate through all target channels (original + patched ones)
            for (const ch of targetChannels) {
              servers[ch].forEach((server_address) => {
                // console.log("🚀 ~ servers[ch].forEach ~ server_address:", server_address,members[ch])

                if(server_address == process.env.AUDIOSERVER_ADDR) {
                  members[ch].forEach((p) => {
                  // if(p != port && udpSockets[p] && udpClients[p]) {

                  if(udpSockets[p]) {
                    udpSockets[p].send(JSON.stringify(packet), udpClients[p].port, udpClients[p].address, (err) => {
                      // console.log("🚀 ~ udpSockets[p].send ~ udpClients[p].port, udpClients[p].address:", udpClients[p].port, udpClients[p].address)
                      if (err) {
                        console.error(`Failed to send to ${udpClients[p].address}:${udpClients[p].port}`, err);
                      } else {
                        // console.log(`Forwarded packet to ${udpClients[p].address}:${udpClients[p].port}`);
                      }
                    });
                  }
                });
                } else {
                  const [ip, p] = server_address.split(":");
                  // console.log("🚀 ~ members[packet.channel_id].forEach ~ ip, p:", ip, p)
                  packet.channel_id=ch;
                  machineSocket.send(JSON.stringify({packet, port}), p, ip, (err) => {
                    if (err) {
                      console.error(`Failed to send to ${ip}:${p}`, err);
                    } else {
                      // console.log(`Forwarded packet to ${ip}:${p}`);
                    }
                  })
                  }
              });
            }
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

function patchChannels(channels) {
  
  const mergedSet = new Set(channels);
  const groupsToRemove = [];

  // Find and merge overlapping groups
  for (const group of patchedGroups) {
    if (group.some(ch => mergedSet.has(ch))) {
      for (const ch of group) mergedSet.add(ch);
      groupsToRemove.push(group);
    }
  }

  // Remove old groups that are merged
  for (const group of groupsToRemove) {
    const index = patchedGroups.indexOf(group);
    if (index !== -1) patchedGroups.splice(index, 1);
  }

  // Add merged group
  const mergedArray = Array.from(mergedSet);
  patchedGroups.push(mergedArray);

  // Update channel set
  for (const ch of mergedArray) patchedChannelSet.add(ch);
}

function unpatchChannels(channelsToRemove) {
  for (let i = patchedGroups.length - 1; i >= 0; i--) {
    const group = patchedGroups[i];

    // Remove requested channels from the group
    const filtered = group.filter(ch => !channelsToRemove.includes(ch));

    if (filtered.length <= 1) {
      // Group is either empty or has only one channel — remove it
      patchedGroups.splice(i, 1);
    } else if (filtered.length !== group.length) {
      // Group is still valid but has been updated
      patchedGroups[i] = filtered;
    }
  }

  // Rebuild patchedChannelSet from updated groups
  patchedChannelSet.clear();
  for (const group of patchedGroups) {
    for (const ch of group) {
      patchedChannelSet.add(ch);
    }
  }
}



app.post("/channels/patch", async (req, res) => {
  const { channels  } = req.body;
  if (!channels || channels.length < 2 ) {
    return res.status(400).json({ error: "Provide at least two channels." });
  }
  patchChannels(channels);

  try {
    // update patchedGroups and patchedChannelSet...
    await savePatchedDataToRedis();
    await publisher.publish("patched_info", JSON.stringify({"type": "PATCH", channels }));


    res.json({ message: "Channels patched successfully." });
  } catch (err) {
    console.error("Patch error:", err);
    res.status(500).json({ error: "Patch failed." });
  }
});
app.post("/channels/unpatch", async (req, res) => {
  const { channels } = req.body;
  if (!channels) {
    return res.status(400).json({ error: "Provide channels to unmerge." });
  }
  unpatchChannels(channels);

  try {
    await savePatchedDataToRedis();
    await publisher.publish("patched_info", JSON.stringify({"type": "UNPATCH", channels }));

    res.json({ message: "Channels unpatched successfully." });
  } catch (err) {
    console.error("Unmerge error:", err);
    res.status(500).json({ error: "Failed to unmerge." });
  }
});
