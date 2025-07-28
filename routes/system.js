const express = require('express');
const os = require('os');

function createSystemRoutes(redis) {
  const router = express.Router();

  // Audio server connected users endpoint
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
      res.json({ 
        udpSockets: global.udpSockets, 
        members: global.members, 
        udpClients: global.udpClients, 
        users, 
        servers: global.servers, 
        patches: global.patches 
      });
    } catch (err) {
      res.json([]);
    }
  });

  // System stats endpoint
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

  // Health check endpoint
  router.get('/health', (req, res) => {
    res.json(global.serverPublicIP);
  });

  // Patches endpoint
  router.get("/patches", async (req, res) => {
    res.json(global.patches);
  });

  return router;
}

module.exports = createSystemRoutes;