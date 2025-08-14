const express = require('express');
const os = require('os');

function createSystemRoutes(redis) {
  const router = express.Router();
  
  // Store process start time
  const processStartTime = Date.now();

  setInterval(async () => {
    await redis.hset(`server_status`, `${global.serverPublicIP}`, JSON.stringify({
      ip: global.serverPublicIP,
      udpSockets: global.udpSockets,
      members: global.members,
      udpClients: global.udpClients,
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
      memory: {
        total: (os.totalmem() / 1024 / 1024).toFixed(2) + ' MB',
        free: (os.freemem() / 1024 / 1024).toFixed(2) + ' MB',
        used: ((os.totalmem() - os.freemem()) / 1024 / 1024).toFixed(2) + ' MB',
        usagePercent: ((1 - os.freemem() / os.totalmem()) * 100).toFixed(2) + '%'
      },
      uptime: Math.floor((Date.now() - processStartTime) / 1000) + ' seconds'
    }));
  }, 1000);

  // Audio server connected users endpoint (original format)
  router.get("/audio-server-connected-users", async (req, res) => {
    try {
      // Get all server statuses from Redis hash
      const rawStatuses = await redis.hgetall("server_status");


      const keys = await redis.keys("*_members");
      const users = {};
      for (const key of keys) {
        const channel_id = key.replace("_members", "");
        const entries = await redis.hgetall(key);
        const parsedEntries = Object.entries(entries).map(([socketId, value]) => ({
          socketId,
          channel_id,
          ...JSON.parse(value)
        }));
        users[channel_id] = parsedEntries;
      }

      // Convert hash { ip1: json, ip2: json, ... } into array of parsed objects
      const statuses = Object.entries(rawStatuses).map(([ip, json]) => {
        try {
          return { ip, ...JSON.parse(json) };
        } catch (err) {
          // If bad JSON, still include IP but mark it
          return { ip, error: "Invalid JSON in status value" };
        }
      });

      res.json({
        count: statuses.length,
        users,  // how many servers
        servers: global.servers,
        patches: global.patches,
        statuses                 // array of all server status objects
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Health check endpoint
  router.get('/health', (req, res) => {
    res.json(global.serverPublicIP);
  });

  // Patches endpoint
  router.get("/patches", async (req, res) => {
    res.json(global.patches);
  });

  // Dashboard route
  router.get('/dashboard', (req, res) => {
    res.sendFile('dashboard.html', { root: '.' });
  });

  return router;
}

module.exports = createSystemRoutes;