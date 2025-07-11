const { redis } = require('../config/redis');

let patchedGroups = [];
let patchedChannelSet = new Set();

async function initializePatchedData() {
  try {
    const groupData = await redis.get("patched_groups");
    if (groupData) {
      patchedGroups = JSON.parse(groupData);
    }
    console.log("🚀 ~ patchedGroups:", patchedGroups)

    const channels = await redis.smembers("patched_channel_set");
    if (channels && channels.length > 0) {
      patchedChannelSet = new Set(channels);
    }

    console.log("✅ Patched data loaded from Redis:", patchedGroups);
  } catch (err) {
    console.error("❌ Failed to load patched data from Redis:", err);
  }
}

async function savePatchedDataToRedis() {
  await redis.set("patched_groups", JSON.stringify(patchedGroups));
  await redis.del("patched_channel_set");
  if (patchedChannelSet.size > 0) {
    await redis.sadd("patched_channel_set", [...patchedChannelSet]);
  }
}

function patchChannels(channels) {
  const mergedSet = new Set(channels);
  const groupsToRemove = [];

  for (const group of patchedGroups) {
    if (group.some(ch => mergedSet.has(ch))) {
      for (const ch of group) mergedSet.add(ch);
      groupsToRemove.push(group);
    }
  }

  for (const group of groupsToRemove) {
    const index = patchedGroups.indexOf(group);
    if (index !== -1) patchedGroups.splice(index, 1);
  }

  const mergedArray = Array.from(mergedSet);
  patchedGroups.push(mergedArray);

  for (const ch of mergedArray) patchedChannelSet.add(ch);
}

function unpatchChannels(channelsToRemove) {
  for (let i = patchedGroups.length - 1; i >= 0; i--) {
    const group = patchedGroups[i];

    const filtered = group.filter(ch => !channelsToRemove.includes(ch));

    if (filtered.length <= 1) {
      patchedGroups.splice(i, 1);
    } else if (filtered.length !== group.length) {
      patchedGroups[i] = filtered;
    }
  }

  patchedChannelSet.clear();
  for (const group of patchedGroups) {
    for (const ch of group) {
      patchedChannelSet.add(ch);
    }
  }
}

module.exports = {
  initializePatchedData,
  savePatchedDataToRedis,
  patchChannels,
  unpatchChannels,
  get patchedGroups() { return patchedGroups; },
  get patchedChannelSet() { return patchedChannelSet; }
};