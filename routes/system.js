const express = require('express');
const os = require('os');
const { SchedulerClient, CreateScheduleCommand } = require("@aws-sdk/client-scheduler");


function createSystemRoutes(redis, publisher, sentinelClient) {
  const router = express.Router();

  // Store process start time
  const processStartTime = Date.now();

  // let redisWritable = false;

  // Check if Redis is writable before starting the interval
  // redis.info('replication').then(info => {
  //   redisWritable = !(info.includes('role:slave') || info.includes('role:replica'));
  //   if (!redisWritable) {
  //     console.warn("[system] Redis is read-only, server status updates disabled");
  //   } else {
  //     console.log("[system] Redis is writable, server status updates enabled");
  //   }
  // }).catch(err => {
  //   console.error("[system] Failed to check Redis role:", err);
  //   redisWritable = false;
  // });

  setInterval(async () => {
    // if (!redisWritable) {
    //   return; // Skip if Redis is read-only
    // }

    // try {
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
      uptime: Math.floor((Date.now() - processStartTime) / 1000) + ' seconds',
      updatedAt: Date.now()
    }));
    // } catch (err) {
    //   if (err.message && err.message.includes('READONLY')) {
    //     console.warn("[system] Redis became read-only, disabling server status updates");
    //     redisWritable = false;
    //   } else {
    //     console.error("[system] Error updating server status:", err);
    //   }
    // }
  }, 1000);

  // Audio server connected users endpoint (original format)
  router.get("/audio-server-connected-users", async (req, res) => {
    try {
      // Get all server statuses from Redis hash
      const rawStatuses = await redis.hgetall("server_status");
      const streamingStatuses = await redis.hgetall("streaming_server_stats");

      console.log("streamingStatuses:", streamingStatuses);

      // Parse streaming statuses
      const parsedStreamingStatuses = {};
      for (const [key, jsonData] of Object.entries(streamingStatuses)) {
        try {
          parsedStreamingStatuses[key] = JSON.parse(jsonData);
        } catch (err) {
          console.error(`Error parsing streaming status for key ${key}:`, err);
          parsedStreamingStatuses[key] = { error: "Invalid JSON in streaming status" };
        }
      }

      // Clean up old entries (older than 5 minutes)
      const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
      const entriesToDelete = [];

      for (const [ip, jsonData] of Object.entries(rawStatuses)) {
        try {
          const data = JSON.parse(jsonData);
          if (!data.updatedAt || data.updatedAt < fiveMinutesAgo) {
            entriesToDelete.push(ip);
          }
        } catch (err) {
          // If JSON is malformed, also mark for deletion
          entriesToDelete.push(ip);
        }
      }

      // Remove old entries from Redis
      if (entriesToDelete.length > 0) {
        await redis.hdel("server_status", ...entriesToDelete);
        // Remove the deleted entries from our local copy
        entriesToDelete.forEach(ip => delete rawStatuses[ip]);
      }

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

      // Get Sentinel masters & slaves info using the shared sentinelClient
      let masters = [];
      let slaves = [];
      let redisError = null;

      // if (sentinelClient) {
      try {
        masters = await sentinelClient.send_command("SENTINEL", ["masters"]);
        slaves = await sentinelClient.send_command("SENTINEL", ["slaves", process.env.REDIS_MASTER_NAME || "mymaster"]);
      } catch (redisErr) {
        redisError = redisErr.message;
        console.error('Redis Sentinel error:', redisErr);
        //   }
        // } else {
        //   redisError = "Redis Sentinel not configured - using direct connection";
      }

      const response = {
        count: statuses.length,
        users,  // how many servers
        servers: global.servers,
        patches: global.patches,
        statuses, // array of all server status objects
        streamingStatuses: parsedStreamingStatuses, // parsed streaming server stats
        redis: redisError ? {
          error: redisError
        } : {
          masters: masters,
          slaves: slaves
        }
      };

      res.json(response);
    } catch (err) {
      res.status(500).json({
        error: err.message,
        redis: {
          error: err.message
        }
      });
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

  // EC2 instance detachment endpoint
  router.get('/detach-instance/:ip', async (req, res) => {
    try {
      publisher.publish("terminations", req.params.ip);
      res.json({"terminating": true})
      return;
    } catch (error) {
      console.error('Error detaching EC2 instance:', error);
      res.status(500).json({
        error: `Failed to detach instance: ${error.message}`,
        success: false
      });
    }
  });

  return router;
}

module.exports = createSystemRoutes;