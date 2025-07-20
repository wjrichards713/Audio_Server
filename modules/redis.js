const Redis = require("ioredis");
require('dotenv').config();

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

async function getChannel(channelId) {
  const raw = await redis.hget('channels', channelId);
  return raw ? JSON.parse(raw) : null;
}

async function savePatchedDataToRedis(patchedGroups, patchedChannelSet) {
  await redis.set("patched_groups", JSON.stringify(patchedGroups));
  await redis.del("patched_channel_set");
  if (patchedChannelSet.size > 0) {
    await redis.sadd("patched_channel_set", [...patchedChannelSet]);
  }
}

module.exports = {
  redis,
  publisher,
  subscriber,
  getChannel,
  savePatchedDataToRedis
};