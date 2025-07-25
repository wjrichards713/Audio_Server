const Redis = require("ioredis");
const { getPublicIP } = require('./utils');

function setupRedis() {
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
      Object.assign(global.patches, parsed);
    }
    const keys = await redis.keys('*');
    global.serverPublicIP = await getPublicIP();
    for (const key of keys) {
      if (key.endsWith('_servers')) {
        const members = await redis.smembers(key);
        for (const member of members) {
          if (member.startsWith(global.serverPublicIP)) {
            await redis.srem(key, member);
            console.log(`Removed ${member} from ${key}`);
            await publisher.publish('server_channel_sync', key.replace("_servers", ''));
          }
        }
      }
      if (key.endsWith('_members')) {
        const members = await redis.hgetall(key);
        for (const field in members) {
          if (field.startsWith(global.serverPublicIP)) {
            await redis.hdel(key, field);
            console.log(`Removed ${field} from ${key}`);
          }
        }
      }
    }
  });

  return { redis, publisher, subscriber, redis_channel_subscriptions };
}

module.exports = setupRedis;