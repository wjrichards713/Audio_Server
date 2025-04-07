const dgram = require("dgram");
const WebSocket = require('ws');
const express = require('express');
const cors = require("cors");
require('dotenv').config();

const Redis = require("ioredis");

const udpSockets = {};
const udpClients = {};
const servers = {};
const members = {};
const users = {};
const channels = {}; // Local cache of channels from Redis
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('client'));
app.get("/audio-server-port", async (req, res) => {
  try {
    const {socket, port} = await createSocket();
    await socket.close();
    delete udpSockets[port];
    res.json({
      udp_port: port,
      websocket_id: port,
      udp_host: process.env.AUDIOSERVER_ADDR.split(":")[0],
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
    res.json({ udpSockets, members, udpClients, users, servers, channels });
  } catch (err) {
    res.json([]);
  }
});

// Channel management API endpoints
app.get("/channels", async (req, res) => {
  try {
    const allChannels = await getAllChannels();
    res.json(allChannels);
  } catch (err) {
    console.error("Error fetching channels:", err);
    res.status(500).json({ error: "Failed to fetch channels" });
  }
});

app.get("/channels/:channelId", async (req, res) => {
  try {
    const channelData = await getChannel(req.params.channelId);
    if (!channelData) {
      return res.status(404).json({ error: "Channel not found" });
    }
    res.json(channelData);
  } catch (err) {
    console.error("Error fetching channel:", err);
    res.status(500).json({ error: "Failed to fetch channel" });
  }
});

app.post("/channels", async (req, res) => {
  try {
    const { channelId, ...channelData } = req.body;
    
    if (!channelId) {
      return res.status(400).json({ error: "Channel ID is required" });
    }
    
    const result = await storeChannel(channelId, channelData);
    
    if (result) {
      // Notify all servers about the new channel
      await publisher.publish('channels', JSON.stringify({
        action: 'add',
        channelId,
        data: channelData
      }));
      
      res.status(201).json({ channelId, ...channelData });
    } else {
      res.status(500).json({ error: "Failed to store channel" });
    }
  } catch (err) {
    console.error("Error creating channel:", err);
    res.status(500).json({ error: "Failed to create channel" });
  }
});

app.put("/channels/:channelId", async (req, res) => {
  try {
    const channelId = req.params.channelId;
    const channelData = req.body;
    
    const existingChannel = await getChannel(channelId);
    if (!existingChannel) {
      return res.status(404).json({ error: "Channel not found" });
    }
    
    const result = await storeChannel(channelId, channelData);
    
    if (result) {
      // Notify all servers about the updated channel
      await publisher.publish('channels', JSON.stringify({
        action: 'update',
        channelId,
        data: channelData
      }));
      
      res.json({ channelId, ...channelData });
    } else {
      res.status(500).json({ error: "Failed to update channel" });
    }
  } catch (err) {
    console.error("Error updating channel:", err);
    res.status(500).json({ error: "Failed to update channel" });
  }
});

app.delete("/channels/:channelId", async (req, res) => {
  try {
    const channelId = req.params.channelId;
    
    const existingChannel = await getChannel(channelId);
    if (!existingChannel) {
      return res.status(404).json({ error: "Channel not found" });
    }
    
    const result = await removeChannel(channelId);
    
    if (result) {
      // Notify all servers about the deleted channel
      await publisher.publish('channels', JSON.stringify({
        action: 'delete',
        channelId
      }));
      
      res.status(204).send();
    } else {
      res.status(500).json({ error: "Failed to delete channel" });
    }
  } catch (err) {
    console.error("Error deleting channel:", err);
    res.status(500).json({ error: "Failed to delete channel" });
  }
});
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

// Channel management functions
async function storeChannel(channelId, channelData) {
  try {
    // Convert object to flat key-value pairs for Redis hash
    const channelEntries = Object.entries(channelData);
    
    if (channelEntries.length > 0) {
      const redisArgs = ["channel_" + channelId];
      
      // Flatten object into alternating key-value pairs for hset
      channelEntries.forEach(([key, value]) => {
        // Serialize non-string values to JSON
        const serializedValue = typeof value === 'string' ? value : JSON.stringify(value);
        redisArgs.push(key, serializedValue);
      });
      
      await redis.hset(...redisArgs);
      await redis.sadd("channels", channelId);
      channels[channelId] = channelData;
      console.log(`Channel ${channelId} stored in Redis with ${channelEntries.length} properties`);
      return true;
    } else {
      console.error("No channel data provided for storage");
      return false;
    }
  } catch (error) {
    console.error("Error storing channel:", error);
    return false;
  }
}

async function getChannel(channelId) {
  try {
    const channelData = await redis.hgetall("channel_" + channelId);
    
    if (Object.keys(channelData).length > 0) {
      // Try to deserialize any JSON values
      const parsedData = {};
      
      for (const [key, value] of Object.entries(channelData)) {
        try {
          // Try to parse as JSON, if it fails, use the raw value
          parsedData[key] = JSON.parse(value);
        } catch (e) {
          parsedData[key] = value;
        }
      }
      
      return parsedData;
    }
    
    return null;
  } catch (error) {
    console.error("Error getting channel:", error);
    return null;
  }
}

async function getAllChannels() {
  try {
    const channelIds = await redis.smembers("channels");
    const channelsData = {};
    
    for (const channelId of channelIds) {
      const channelData = await getChannel(channelId);
      if (channelData) {
        channelsData[channelId] = channelData;
      }
    }
    
    return channelsData;
  } catch (error) {
    console.error("Error getting all channels:", error);
    return {};
  }
}

async function removeChannel(channelId) {
  try {
    await redis.del("channel_" + channelId);
    await redis.srem("channels", channelId);
    delete channels[channelId];
    console.log(`Channel ${channelId} removed from Redis`);
    return true;
  } catch (error) {
    console.error("Error removing channel:", error);
    return false;
  }
}

// Initialize channels from Redis on startup
async function initChannels() {
  try {
    const channelsData = await getAllChannels();
    Object.assign(channels, channelsData);
    console.log(`Loaded ${Object.keys(channels).length} channels from Redis`);
  } catch (error) {
    console.error("Error initializing channels:", error);
  }
}

// Initialize channels on startup
initChannels();

subscriber.subscribe('servers');
subscriber.subscribe('channels');
subscriber.on("message", async (channel_id, data) => {
  if(channel_id == 'servers') {
    console.log("Global Redis Message", {channel_id, data});
    const channel_servers = await redis.smembers("server_"+data);
    if(channel_servers && channel_servers.length) {
      servers[data] = channel_servers;
    } else {
      delete servers[data];
    }
    // tell every other server to connect to this server via udp
    return;
  }
  
  if(channel_id == 'channels') {
    try {
      const channelData = JSON.parse(data);
      console.log("Channel update received", channelData);
      
      if (channelData.action === 'add' || channelData.action === 'update') {
        channels[channelData.channelId] = channelData.data;
        console.log(`Channel ${channelData.channelId} updated in local cache`);
      } else if (channelData.action === 'delete') {
        delete channels[channelData.channelId];
        console.log(`Channel ${channelData.channelId} removed from local cache`);
      } else if (channelData.action === 'refresh') {
        // Force a refresh of the channels cache
        await initChannels();
      }
    } catch (error) {
      console.error("Error processing channel update:", error);
    }
    return;
  }
  const {message, websocketId} = JSON.parse(data);
  console.log("Redis Message", {message, websocketId});
  if(message.connect) {
    const users_connected = [...new Set((await redis.hvals("member_" + channel_id)).map(JSON.parse).map(item => item.user))];
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN && members[channel_id].includes(client.websocketId)) {
        if(client.websocketId != websocketId) {
          // client.send(JSON.stringify({...message, channel_id}));
          client.send(JSON.stringify({ channel_id, users_connected: users_connected }));
        } else {
          client.send(JSON.stringify({ channel_id, users_connected: users_connected }));
        }
      }
    });
  } else if (message.disconnect) {
    const users_connected = [...new Set((await redis.hvals("member_" + channel_id)).map(JSON.parse).map(item => item.user))];
    if(members[channel_id].length) {
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && members[channel_id].includes(client.websocketId) && client.websocketId != websocketId) {
          // client.send(JSON.stringify(message));
          client.send(JSON.stringify({ channel_id, users_connected: users_connected }));
        }
      });
    } else {
      console.log("Unsubscribing, ", channel_id);
      await redis.srem("server_"+channel_id, process.env.AUDIOSERVER_ADDR);
      await subscriber.unsubscribe(channel_id);
      await publisher.publish('servers', channel_id);
      activeRedisSubscriptions.delete(channel_id);
      delete members[channel_id];
    }
  } else if(channel_id) {
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN && members[channel_id].includes(client.websocketId) && client.websocketId != websocketId) {
        client.send(JSON.stringify(message));
      }
    });
  }
});
async function getChannel(channelId) {
  const raw = await redis.hget('channels', channelId);
  return raw ? JSON.parse(raw) : null;
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
      console.log("Websocket Message", message);

      if(message.connect) {
        const {channel_id} = message.connect;
        if(!await getChannel(channel_id)) {
          return;
        }
        
        // Check if the channel exists in Redis
        const channelData = await getChannel(channel_id);
        
        // Only allow connection if channel exists in Redis or local cache
        if (!channelData && !channels[channel_id]) {
          console.log(`Rejecting connection to non-existent channel: ${channel_id}`);
          
          // Send rejection message to client
          socket.send(JSON.stringify({
            error: true,
            message: `Channel ${channel_id} does not exist`,
            code: "CHANNEL_NOT_FOUND"
          }));
          
          return; // Stop processing this connection
        }
        
        try {
          udpSockets[websocketId].address();
        } catch ($e) {
          await createSocket(websocketId);
        }
        
        members[channel_id] = [...(members[channel_id] || []).filter((port) => port != websocketId), websocketId]; // update members to have new user added, members contains socket ids of this server only
        await redis.hset("member_" + channel_id, `${process.env.AUDIOSERVER_ADDR.split(":")[0]}:${websocketId}`, JSON.stringify(message.connect));
        await redis.sadd("server_" + channel_id, process.env.AUDIOSERVER_ADDR);
        await publisher.publish('servers', channel_id); // inform all servers about the update has been made
        
        if (!activeRedisSubscriptions.has(channel_id)) {
          await subscriber.subscribe(channel_id);
          activeRedisSubscriptions.add(channel_id);
        }
        
        // Send confirmation message to client
        socket.send(JSON.stringify({
          success: true,
          message: `Connected to channel ${channel_id}`,
          channel_id,
          channel_data: channelData || channels[channel_id]
        }));
        
        await publisher.publish(channel_id, JSON.stringify({message, websocketId})); // broadcast the message as it is to all servers, so other clients will get it

      } else if(message.disconnect) {
        const {channel_id} = message.disconnect;
        members[channel_id] = (members[channel_id] || []).filter((port) => port != websocketId);
        await redis.hdel(
          "member_" + channel_id,
          `${process.env.AUDIOSERVER_ADDR.split(":")[0]}:${websocketId}`
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
  socket.on('close', async () => {
    console.log('WebSocket User Disconnected', req.url);
    const channels = Object.keys(members);
    channels.forEach(async (channel_id) => {
      if(members[channel_id].includes(websocketId)) {
        members[channel_id] = (members[channel_id] || []).filter((port) => port != websocketId);
        const user = JSON.parse(await redis.hget("member_" + channel_id, `${process.env.AUDIOSERVER_ADDR.split(":")[0]}:${websocketId}`));
        await redis.hdel(
          "member_" + channel_id,
          `${process.env.AUDIOSERVER_ADDR.split(":")[0]}:${websocketId}`
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
  console.log('Socket bound to port '+port);
  machineSocket.on('error', (err) => {
      console.error('Socket error:', err);
  });
  machineSocket.on("message", async (data, rinfo) => {
    try {
      const {packet, port} = JSON.parse(data.toString('utf-8'));
      if (packet.channel_id && members[packet.channel_id]) {
        // Verify the channel exists in Redis or local cache
        const channelExists = channels[packet.channel_id] || await getChannel(packet.channel_id);
        
        if (channelExists) {
          console.log(packet, port, members[packet.channel_id]);
          members[packet.channel_id].forEach((p) => {
            if(p != port && udpSockets[p] && udpClients[p]) {
              udpSockets[p].send(JSON.stringify(packet), udpClients[p].port, udpClients[p].address, (err) => {
                if (err) {
                  console.error(`Failed to send to ${udpClients[p].address}:${udpClients[p].port}`, err);
                } else {
                  console.log(`Forwarded packet to ${udpClients[p].address}:${udpClients[p].port}`);
                }
              });
            }
          });
        } else {
          console.log(`Packet for unknown channel ${packet.channel_id} - ignoring`);
        }
      }
    } catch ($e) { 
      console.error("Error processing machine socket message:", $e);
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
      socket.on("message", async (msg, rinfo) => {
        // console.log(rinfo, msg.toString('utf-8'));
        reinitTimeout();
        udpClients[port] = rinfo;
        try {
          const packet = JSON.parse(msg.toString('utf-8'));
          if (packet.channel_id && members[packet.channel_id]) {
            // Verify the channel exists in Redis or local cache
            const channelExists = channels[packet.channel_id] || await getChannel(packet.channel_id);
            
            if (channelExists && servers[packet.channel_id]) {
              servers[packet.channel_id].forEach((server_address) => {
                const [ip, p] = server_address.split(":");
                machineSocket.send(JSON.stringify({packet, port}), p, ip, (err) => {
                  if (err) {
                    console.error(`Failed to send to ${ip}:${p}`, err);
                  } else {
                    console.log(`Forwarded packet to ${ip}:${p}`);
                  }
                });
              });
            } else {
              console.log(`Packet for unknown or invalid channel ${packet.channel_id} - not forwarding`);
            }
          }
        } catch ($e) {
          console.error("Error processing socket message:", $e);
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