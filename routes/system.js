const express = require('express');
const os = require('os');
const http = require("http");


function createSystemRoutes(redis, publisher, sentinelClient) {
  const router = express.Router();

  const SERVER_STATUS_KEY = "server_status";
  const STREAMING_STATS_KEY = "streaming_server_stats";
  const SERVER_VERSIONS_KEY = "server_versions";
  const LATEST_VERSION_KEY = "version_details";

  // Add this constant near your other keys
  const REST_SERVER_STATUS_KEY = "REST_Server_Status";

  // helper: keep only the fields we care about
  function sanitizeRestStatus(obj) {
    if (!obj || typeof obj !== "object") return obj;
    return {
      ip: obj.ip || null,
      cpu: Array.isArray(obj.cpu) ? obj.cpu : [],
      memory: obj.memory || {},
      uptime: obj.uptime ?? null,
      updatedAt: obj.updatedAt ?? null,
    };
  }

  const processStartTime = Date.now();

  async function getRegionAndInstanceId() {
    // 1) IMDSv2 token
    const token = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          method: "PUT",
          host: "169.254.169.254",
          path: "/latest/api/token",
          headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
          timeout: 1000,
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve(data));
        }
      );
      req.on("error", reject);
      req.end();
    });

    // 2) Instance identity doc
    return await new Promise((resolve, reject) => {
      const req = http.request(
        {
          method: "GET",
          host: "169.254.169.254",
          path: "/latest/dynamic/instance-identity/document",
          headers: { "X-aws-ec2-metadata-token": token },
          timeout: 1000,
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            try {
              const doc = JSON.parse(data);
              resolve({
                region: doc.region,
                instanceId: doc.instanceId,
                accountId: doc.accountId,
                availabilityZone: doc.availabilityZone,
              });
            } catch (e) {
              reject(e);
            }
          });
        }
      );
      req.on("error", reject);
      req.end();
    });
  }

  async function getCpuInfo() {
    const cpus = os.cpus();
    return cpus.map((core, index) => {
      const total = Object.values(core.times).reduce((acc, tv) => acc + tv, 0);
      const usage = ((total - core.times.idle) / total) * 100;
      return {
        core: index,
        model: core.model,
        speed: core.speed,
        usage: usage.toFixed(2) + "%",
      };
    });
  }

  async function getMemInfo() {
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const usedBytes = totalBytes - freeBytes;
    const asMB = (n) => (n / 1024 / 1024).toFixed(2) + " MB";
    return {
      total: asMB(totalBytes),
      free: asMB(freeBytes),
      used: asMB(usedBytes),
      usage_percent: ((usedBytes / totalBytes) * 100).toFixed(2) + "%", // snake_case + % like your sample
    };
  }

  // push every second
  setInterval(async () => {
    try {
      const { region } = await getRegionAndInstanceId();

      const payload = {
        ip: global.serverPublicIP,
        name: global.serverName,                 // "Server AF"
        region,                                  // e.g. "us-east-1"
        status: global.serverStatus,             // "online"
        requests_per_second: global.requestsPerSecond || 0,
        average_response_time_ms: global.avgResponseTime || 0,
        failed_requests: global.failedRequests || 0,
        cpu: await getCpuInfo(),                 // [{ core, model, speed, usage }]
        memory: await getMemInfo(),              // { total, free, used, usage_percent }
        uptime: Math.floor((Date.now() - processStartTime) / 1000) + " seconds",
        updated_at: Date.now(),                  // epoch ms
      };

      await redis.hset("server_status", global.serverPublicIP, JSON.stringify(payload));
    } catch (err) {
      console.error("Failed to update server_status:", err);
    }
  }, 1000);
  // Audio server connected users endpoint (original format)
  router.get("/audio-server-connected-users", async (req, res) => {
    try {
      // Fetch everything we need in parallel (added REST server status)
      const [
        rawStatuses,
        streamingStatuses,
        rawVersions,
        rawLatest,
        rawRestStatuses, // <-- new
      ] = await Promise.all([
        redis.hgetall(SERVER_STATUS_KEY),
        redis.hgetall(STREAMING_STATS_KEY),
        redis.hgetall(SERVER_VERSIONS_KEY),
        redis.get(LATEST_VERSION_KEY),
        redis.hgetall(REST_SERVER_STATUS_KEY),
      ]);
  
      // Parse streaming statuses and clean up old entries
      const parsedStreamingStatuses = {};
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
      const streamingEntriesToDelete = [];
      
      for (const [key, jsonData] of Object.entries(streamingStatuses || {})) {
        try {
          const streamingData = JSON.parse(jsonData);
          
          // Check if entry is older than 24 hours
          if (!streamingData.updatedAt || streamingData.updatedAt < fiveMinutesAgo) {
            streamingEntriesToDelete.push(key);
          } else {
            parsedStreamingStatuses[key] = streamingData;
          }
        } catch (err) {
          console.error(`Error parsing streaming status for key ${key}:`, err);
          // Also remove entries with invalid JSON
          streamingEntriesToDelete.push(key);
        }
      }
      
      // Remove old streaming entries from Redis
      if (streamingEntriesToDelete.length > 0) {
        await redis.hdel(STREAMING_STATS_KEY, ...streamingEntriesToDelete);
        console.log(`Removed ${streamingEntriesToDelete.length} old streaming server entries:`, streamingEntriesToDelete);
      }
  
      // Clean up old entries for SERVER_STATUS_KEY only (unchanged)
      const entriesToDelete = [];
      for (const [ip, jsonData] of Object.entries(rawStatuses || {})) {
        try {
          const data = JSON.parse(jsonData);
          if (!data.updatedAt || data.updatedAt < fiveMinutesAgo) {
            entriesToDelete.push(ip);
          }
        } catch {
          entriesToDelete.push(ip);
        }
      }
      if (entriesToDelete.length > 0) {
        await redis.hdel(SERVER_STATUS_KEY, ...entriesToDelete);
        entriesToDelete.forEach((ip) => delete rawStatuses[ip]);
      }
  
      // Users across channels (unchanged)
      const keys = await redis.keys("*_members");
      const users = {};
      for (const key of keys) {
        const channel_id = key.replace("_members", "");
        const entries = await redis.hgetall(key);
        const parsedEntries = Object.entries(entries || {}).map(([socketId, value]) => ({
          socketId,
          channel_id,
          ...JSON.parse(value),
        }));
        users[channel_id] = parsedEntries;
      }
  
      // Convert statuses hash -> array (unchanged)
      const baseStatuses = Object.entries(rawStatuses || {}).map(([ip, json]) => {
        try {
          return { ip, ...JSON.parse(json) };
        } catch {
          return { ip, error: "Invalid JSON in status value" };
        }
      });
  
      // Parse latest version (unchanged)
      let latestVersion = null;
      if (rawLatest) {
        try {
          const j = JSON.parse(rawLatest); // { version, zipFile, updatedAt, ... }
          if (j && j.version && j.zipFile) latestVersion = j;
        } catch (e) {
          console.error("Invalid JSON in version_details:", e);
        }
      }
  
      // Per-server versions (unchanged)
      const serverVersions = Object.fromEntries(
        Object.entries(rawVersions || {}).map(([ip, json]) => {
          try {
            return [ip, JSON.parse(json)];
          } catch {
            return [ip, { error: "Invalid JSON in version value" }];
          }
        })
      );
  
      // Merge current version into each status (unchanged)
      const statuses = baseStatuses.map((s) => {
        const verFromHash = serverVersions[s.ip];
        const embeddedVersion = s.version ? { version: s.version, zipFile: s.zipFile } : null;
  
        const currentVersion = verFromHash?.version || embeddedVersion?.version || null;
        const currentZipFile = verFromHash?.zipFile || embeddedVersion?.zipFile || null;
  
        const versionDetails = verFromHash || embeddedVersion || null;
  
        const isOutdated = latestVersion?.version
          ? currentVersion
            ? currentVersion !== latestVersion.version
            : true
          : null;
  
        return {
          ...s,
          versionDetails,
          currentVersion,
          currentZipFile,
          isOutdated,
        };
      });
  
      // 👇 NEW: Parse REST server statuses — DO NOT DELETE STALE ENTRIES
      // We parse and sanitize only; we don't remove anything from Redis.
      const restStatuses = Object.entries(rawRestStatuses || {}).map(([ip, json]) => {
        try {
          const parsed = JSON.parse(json);
          return sanitizeRestStatus({ ip, ...parsed });
        } catch {
          return { ip, error: "Invalid JSON in REST server status value" };
        }
      });
  
      // Sentinel info (unchanged)
      let masters = [];
      let slaves = [];
      let redisError = null;
      try {
        masters = await sentinelClient.send_command("SENTINEL", ["masters"]);
        slaves = await sentinelClient.send_command(
          "SENTINEL",
          ["slaves", process.env.REDIS_MASTER_NAME || "mymaster"]
        );
      } catch (redisErr) {
        redisError = redisErr.message;
        console.error("Redis Sentinel error:", redisErr);
      }

      console.log(rawStatuses);
      
  
      const response = {
        count: statuses.length,
        users,
        servers: global.servers,
        patches: global.patches,
        latestVersion,
        statuses,                   // audio server statuses (with cleanup + version join)
        restStatuses,               // 👈 REST server statuses (no cleanup, sanitized)
        streamingStatuses: parsedStreamingStatuses,
        redis: redisError ? { error: redisError } : { masters, slaves },
      };
  
      res.json(response);
    } catch (err) {
      res.status(500).json({
        error: err.message,
        redis: { error: err.message },
      });
    }
  });

  // --- Versioning endpoints ---

  // Save latest version AND append to history
  router.post("/latest-version", async (req, res) => {
    try {
      const { version, zipFile, metadata } = req.body || {};

      if (!version || !zipFile) {
        return res.status(400).json({ error: "Both 'version' and 'zipFile' are required" });
      }

      const latestKey = "version_details";        // single latest
      const historyKey = "version_history";       // list of history (newest first)
      const now = Date.now();

      const payload = {
        version,
        zipFile,
        metadata: metadata || null,               // optional extra info if you want
        updatedAt: now
      };

      // Use a transaction so both writes happen together
      const multi = redis.multi();
      multi.set(latestKey, JSON.stringify(payload));   // overwrite latest
      multi.lpush(historyKey, JSON.stringify(payload)); // prepend to history

      // Optional: keep only the last N entries (e.g., 200)
      const cap = parseInt(process.env.VERSION_HISTORY_MAX || "200", 10);
      if (cap > 0) {
        multi.ltrim(historyKey, 0, cap - 1);
      }

      await multi.exec();

      res.json({
        success: true,
        message: "Latest version saved and history updated",
        data: payload
      });
    } catch (error) {
      console.error("Error saving latest version:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post("/init-server-versions", async (_req, res) => {
    try {
      // 1) Read the single latest version blob
      const rawLatest = await redis.get(LATEST_VERSION_KEY);
      if (!rawLatest) {
        return res.status(404).json({ error: `No ${LATEST_VERSION_KEY} found` });
      }

      let latest;
      try {
        latest = JSON.parse(rawLatest); // { version, zipFile, updatedAt }
      } catch (e) {
        return res.status(500).json({ error: `Invalid JSON in ${LATEST_VERSION_KEY}` });
      }
      if (!latest.version || !latest.zipFile) {
        return res.status(400).json({ error: `${LATEST_VERSION_KEY} must contain 'version' and 'zipFile'` });
      }

      // 2) Get current servers (fields of server_status hash)
      const rawStatuses = await redis.hgetall(SERVER_STATUS_KEY);
      const ips = Object.keys(rawStatuses || {});
      if (ips.length === 0) {
        return res.status(200).json({ message: "No servers found in server_status; nothing to initialize", initialized: 0 });
      }

      const now = Date.now();
      const multi = redis.multi();
      let updatedCount = 0;

      for (const ip of ips) {
        // 2a) Write per-server version into server_versions
        const versionPayload = {
          ip,
          version: latest.version,
          zipFile: latest.zipFile,
          // keep the latest's timestamp but also record when we initialized
          sourceUpdatedAt: latest.updatedAt || null,
          initializedAt: now
        };
        multi.hset(SERVER_VERSIONS_KEY, ip, JSON.stringify(versionPayload));

        // 2b) Merge into server_status JSON for that IP
        const raw = rawStatuses[ip];
        let statusObj;
        try {
          statusObj = JSON.parse(raw);
        } catch {
          statusObj = { ip }; // salvage minimal shape if malformed
        }
        statusObj.version = latest.version;
        statusObj.zipFile = latest.zipFile;
        statusObj.versionInitializedAt = now;

        multi.hset(SERVER_STATUS_KEY, ip, JSON.stringify(statusObj));
        updatedCount++;
      }

      await multi.exec();

      res.json({
        success: true,
        message: `Initialized version for ${updatedCount} server(s) from ${LATEST_VERSION_KEY}`,
        version: { version: latest.version, zipFile: latest.zipFile },
        servers: ips
      });
    } catch (error) {
      console.error("init-server-versions error:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Read latest version
  router.get("/latest-version", async (_req, res) => {
    try {
      const latestKey = "version_details";
      const raw = await redis.get(latestKey);
      if (!raw) return res.status(404).json({ error: "No version saved yet" });

      res.json(JSON.parse(raw));
    } catch (error) {
      console.error("Error reading latest version:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Read version history (newest first), with pagination
  // /version-history?offset=0&limit=50
  router.get("/version-history", async (req, res) => {
    try {
      const historyKey = "version_history";
      const offset = Math.max(parseInt(req.query.offset || "0", 10), 0);
      const limit = Math.min(Math.max(parseInt(req.query.limit || "50", 10), 1), 500); // sane bounds

      const start = offset;
      const end = offset + limit - 1;

      const rawItems = await redis.lrange(historyKey, start, end);
      const items = rawItems.map((s) => {
        try { return JSON.parse(s); } catch { return { parseError: true, raw: s }; }
      });

      // Also return total count so UI can page
      const total = await redis.llen(historyKey);

      res.json({
        total,
        offset,
        limit,
        items
      });
    } catch (error) {
      console.error("Error reading version history:", error);
      res.status(500).json({ error: error.message });
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

  // Update one server's current version to the latest from `version_details`
  router.post("/update-server/:ip", async (req, res) => {
    console.log(`Request to update server ${req.params.ip}`);
    try {
        console.log(`Request to update server ${req.params.ip}`);
        publisher.publish("update", req.params.ip);
        res.json({"updating": true})
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