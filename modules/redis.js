// setupRedis.js
const Redis = require("ioredis");
const { getPublicIP } = require("./utils");

// Helper to parse REDIS_SENTINELS into [{host, port}, ...]
function parseSentinels(list) {
  if (!list) throw new Error("REDIS_SENTINELS is required");
  return list.split(",").map(s => {
    const [host, portStr] = s.trim().split(":");
    return { host, port: Number(portStr || 26379) };
  });
}

function buildSentinelOptions() {
  const tlsRedis = String(process.env.REDIS_TLS || "false").toLowerCase() === "true";
  const tlsSentinel = String(process.env.SENTINEL_TLS || "false").toLowerCase() === "true";
  const sentinels = parseSentinels(process.env.REDIS_SENTINELS);
  console.log('Sentinel configuration:', sentinels);
  
  /** @type {import('ioredis').RedisOptions} */
  const base = {
    // Tell ioredis to use Sentinel and resolve the current master
    sentinels: sentinels,
    name: process.env.REDIS_MASTER_NAME || "mymaster",

    // Force Sentinel mode - don't fallback to direct connection
    enableAutoPipelining: false,
    lazyConnect: false,
    
    // Auth for the DATA nodes (master/replicas)
    password: process.env.REDIS_PASS,
    username: process.env.REDIS_USER,

    // Auth for Sentinel itself
    sentinelPassword: process.env.SENTINEL_PASS,
    sentinelUsername: process.env.SENTINEL_USER,

    // TLS (if enabled). You can add certs/CA here if your setup uses them.
    // tls: tlsRedis ? {} : undefined

    // Optional tuning
    enableReadyCheck: true,          // verify role before "ready"
    role: "master",                  // always connect to master for writes
    retryDelayOnFailover: 100,       // retry immediately on failover
    enableOfflineQueue: true,        // allow queueing commands when disconnected
    maxRetriesPerRequest: 3,         // max retries per command
    connectTimeout: 10000,           // 10 second timeout
    sentinelConnectTimeout: 5000,    // 5 second sentinel timeout
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 2000);
      console.log(`[redis] retrying connection in ${delay}ms (attempt ${times})`);
      return delay;
    },
    sentinelRetryStrategy: (times) => {
      const delay = Math.min(times * 100, 3000);
      console.log(`[sentinel] retrying connection in ${delay}ms (attempt ${times})`);
      return delay;
    },
    failoverDetector: true
  };

  return base;
}

function setupRedis() {
  const baseOptions = buildSentinelOptions();
  console.log('Redis configuration:', JSON.stringify(baseOptions, null, 2));

  // One base connection for commands (writes/reads)
  const redis = new Redis(baseOptions);

  // Duplicate for pub/sub to avoid command interference
  const publisher = redis.duplicate();
  const subscriber = redis.duplicate();

  // // Add sentinel-specific logging for all clients
  // for (const [name, client] of [
  //   ["redis", redis],
  //   ["publisher", publisher], 
  //   ["subscriber", subscriber],
  // ]) {
  //   client.on("+sentinel", (event) => console.log(`[${name}-sentinel] +sentinel: ${event}`));
  //   client.on("-sentinel", (event) => console.log(`[${name}-sentinel] -sentinel: ${event}`));
  //   client.on("+switch-master", (event) => {
  //     console.log(`[${name}-sentinel] switch-master detected: ${event}`);
  //   });
  //   client.on("sentinelReconnecting", () => console.log(`[${name}] sentinel reconnecting`));
  // }

  // // Helpful logging (optional but very useful during failover tests)
  // for (const [name, client] of [
  //   ["redis", redis],
  //   ["publisher", publisher],
  //   ["subscriber", subscriber],
  // ]) {
  //   client.on("connect", () => {
  //     const connInfo = client.connector.connecting || client.connector.stream;
  //     const host = connInfo?.remoteAddress || client.options.host || 'unknown';
  //     const port = connInfo?.remotePort || client.options.port || 'unknown';
  //     console.log(`[${name}] connect to ${host}:${port}`);
  //   });
  //   client.on("ready", () => {
  //     const connInfo = client.connector.connecting || client.connector.stream;
  //     const host = connInfo?.remoteAddress || client.options.host || 'unknown';
  //     const port = connInfo?.remotePort || client.options.port || 'unknown';
  //     console.log(`[${name}] ready (role resolved) - connected to ${host}:${port}`);
  //   });
  //   client.on("reconnecting", (t) => console.log(`[${name}] reconnecting in ${t}ms`));
  //   client.on("error", (e) => {
  //     if (e.code === 'ECONNRESET') {
  //       console.log(`[${name}] connection reset - likely during failover or network issue`);
  //     } else {
  //       console.error(`[${name}] error: ${e.message} (code: ${e.code})`);
  //     }
  //   });
  //   client.on("end", () => console.log(`[${name}] connection ended`));
  //   client.on("close", () => console.log(`[${name}] connection closed`));
  //   client.on("failover", () => console.log(`[${name}] failover detected`));
  //   client.on("+switch-master", () => console.log(`[${name}] switched to new master`));
  // }

  // Your subscriptions
  const redis_channel_subscriptions = new Set(["server_channel_sync", "patchings"]);

  // Subscribe once "subscriber" is ready; ioredis will auto-resubscribe after reconnects/failovers
  subscriber.on("ready", async () => {
    try {
      for (const ch of redis_channel_subscriptions) {
        await subscriber.subscribe(ch);
      }
      console.log(`[subscriber] subscribed to: ${[...redis_channel_subscriptions].join(", ")}`);
    } catch (err) {
      console.error("[subscriber] subscribe error:", err);
    }
  });

  // (Optional) react to messages
  subscriber.on("message", (channel, message) => {
    // handle messages here if needed
    // console.log(`msg on ${channel}:`, message);
  });

  // Your existing init logic – moved to redis "ready"
  redis.on("ready", async () => {
    try {
      const raw = await redis.get("patches");
      if (raw) {
        const parsed = JSON.parse(raw);
        Object.assign(global.patches, parsed);
      }

      global.serverPublicIP = await getPublicIP();

      const keys = await redis.keys("*");
      for (const key of keys) {
        if (key.endsWith("_servers")) {
          const members = await redis.smembers(key);
          for (const member of members) {
            if (member.startsWith(global.serverPublicIP)) {
              await redis.srem(key, member);
              console.log(`Removed ${member} from ${key}`);
              await publisher.publish("server_channel_sync", key.replace("_servers", ""));
            }
          }
        }
        if (key.endsWith("_members")) {
          const members = await redis.hgetall(key);
          for (const field in members) {
            if (field.startsWith(global.serverPublicIP)) {
              await redis.hdel(key, field);
              console.log(`Removed ${field} from ${key}`);
            }
          }
        }
      }
    } catch (err) {
      console.error("[redis] ready-init error:", err);
    }
  });

  return { redis, publisher, subscriber, redis_channel_subscriptions };
}

module.exports = setupRedis;