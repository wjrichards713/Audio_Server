const express = require('express');
const os = require('os');
const { redis } = require('../config/redis');
const router = express.Router();

router.get("/audio-server-port", async (req, res) => {
  const { getPublicIP } = require('../utils/http');
  const { createSocket } = require('../services/udp');
  
  try {
    let host;
    let serverPublicIP = global.serverPublicIP;
    
    if (serverPublicIP) {
      host = serverPublicIP;
    } else {
      try {
        host = await getPublicIP();
        global.serverPublicIP = host;
        console.log(`Detected public IP: ${host}`);
      } catch (ipError) {
        console.error("Error detecting public IP:", ipError);
        host = 'auto';
      }
    }
    
    const {socket, port} = await createSocket();
    await socket.close();
    
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

router.get("/audio-server-connected-users", async (req, res) => {
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
    
    const { udpSockets, udpClients } = require('../services/udp');
    const { members, servers } = require('../services/websocket');
    
    res.json({ udpSockets, members, udpClients, users, servers });
  } catch (err) {
    res.json([]);
  }
});

router.get('/system-stats', (req, res) => {
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

router.get('/patched-groups', (req, res) => {
  const { patchedGroups } = require('../services/patching');
  res.json({ groups: patchedGroups });
});

module.exports = router;