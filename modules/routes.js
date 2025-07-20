const express = require('express');
const os = require('os');
const { redis, getChannel, publisher, savePatchedDataToRedis } = require('./redis');

function setupRoutes(app, state) {
  const { udpSockets, members, udpClients, servers, patchedGroups, patchedChannelSet } = state;
  
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
      res.json({ udpSockets, members, udpClients, users, servers });
    } catch (err) {
      res.json([]);
    }
  });

  // GET all channels
  app.get("/channels", async (req, res) => {
    try {
      const channels = await redis.hgetall('channels');
      
      // Parse the JSON values in the hash
      const parsedChannels = {};
      for (const [channelId, channelData] of Object.entries(channels)) {
        parsedChannels[channelId] = JSON.parse(channelData);
      }
      
      res.json(parsedChannels);
    } catch (err) {
      console.error("Error fetching channels:", err);
      res.status(500).json({ error: "Failed to retrieve channels" });
    }
  });

  app.get('/patched-groups', (req, res) => {
    res.json({ groups: patchedGroups });
  });

  // GET a single channel
  app.get("/channels/:channelId", async (req, res) => {
    try {
      const { channelId } = req.params;
      const channel = await getChannel(channelId);
      
      if (!channel) {
        return res.status(404).json({ error: "Channel not found" });
      }
      
      res.json(channel);
    } catch (err) {
      console.error("Error fetching channel:", err);
      res.status(500).json({ error: "Failed to retrieve channel" });
    }
  });

  // CREATE or UPDATE a channel
  app.post("/channels", async (req, res) => {
    try {
      const channelData = req.body;
      
      if (!channelData || !channelData.channel_id) {
        return res.status(400).json({ error: "Missing required channel_id field" });
      }
      
      const channelId = channelData.channel_id.toString();
      
      // Store the channel data
      await redis.hset('channels', { [channelId]: JSON.stringify(channelData) });
      
      res.status(201).json({ 
        message: "Channel created/updated successfully",
        channel: channelData 
      });
    } catch (err) {
      console.error("Error creating/updating channel:", err);
      res.status(500).json({ error: "Failed to create/update channel" });
    }
  });

  // DELETE a channel
  app.delete("/channels/:channelId", async (req, res) => {
    try {
      const { channelId } = req.params;
      
      // Check if channel exists first
      const channel = await getChannel(channelId);
      if (!channel) {
        return res.status(404).json({ error: "Channel not found" });
      }
      
      // Delete the channel
      await redis.hdel('channels', channelId);
      
      res.json({ 
        message: "Channel deleted successfully",
        channelId 
      });
    } catch (err) {
      console.error("Error deleting channel:", err);
      res.status(500).json({ error: "Failed to delete channel" });
    }
  });

  // Endpoint for CPU and RAM usage
  app.get('/system-stats', (req, res) => {
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

  app.get('/health', (req, res) => {
    res.json(true);
  });

  function patchChannels(channels) {
    const mergedSet = new Set(channels);
    const groupsToRemove = [];

    // Find and merge overlapping groups
    for (const group of patchedGroups) {
      if (group.some(ch => mergedSet.has(ch))) {
        for (const ch of group) mergedSet.add(ch);
        groupsToRemove.push(group);
      }
    }

    // Remove old groups that are merged
    for (const group of groupsToRemove) {
      const index = patchedGroups.indexOf(group);
      if (index !== -1) patchedGroups.splice(index, 1);
    }

    // Add merged group
    const mergedArray = Array.from(mergedSet);
    patchedGroups.push(mergedArray);

    // Update channel set
    for (const ch of mergedArray) patchedChannelSet.add(ch);
  }

  function unpatchChannels(channelsToRemove) {
    for (let i = patchedGroups.length - 1; i >= 0; i--) {
      const group = patchedGroups[i];

      // Remove requested channels from the group
      const filtered = group.filter(ch => !channelsToRemove.includes(ch));

      if (filtered.length <= 1) {
        // Group is either empty or has only one channel — remove it
        patchedGroups.splice(i, 1);
      } else if (filtered.length !== group.length) {
        // Group is still valid but has been updated
        patchedGroups[i] = filtered;
      }
    }

    // Rebuild patchedChannelSet from updated groups
    patchedChannelSet.clear();
    for (const group of patchedGroups) {
      for (const ch of group) {
        patchedChannelSet.add(ch);
      }
    }
  }

  app.post("/channels/patch", async (req, res) => {
    const { channels  } = req.body;
    if (!channels || channels.length < 2 ) {
      return res.status(400).json({ error: "Provide at least two channels." });
    }
    patchChannels(channels);

    try {
      // update patchedGroups and patchedChannelSet...
      await savePatchedDataToRedis(patchedGroups, patchedChannelSet);
      await publisher.publish("patched_info", JSON.stringify({"type": "PATCH", channels }));

      res.json({ message: "Channels patched successfully." });
    } catch (err) {
      console.error("Patch error:", err);
      res.status(500).json({ error: "Patch failed." });
    }
  });

  app.post("/channels/unpatch", async (req, res) => {
    const { channels } = req.body;
    if (!channels) {
      return res.status(400).json({ error: "Provide channels to unmerge." });
    }
    unpatchChannels(channels);

    try {
      await savePatchedDataToRedis(patchedGroups, patchedChannelSet);
      await publisher.publish("patched_info", JSON.stringify({"type": "UNPATCH", channels }));

      res.json({ message: "Channels unpatched successfully." });
    } catch (err) {
      console.error("Unmerge error:", err);
      res.status(500).json({ error: "Failed to unmerge." });
    }
  });
}

module.exports = {
  setupRoutes
};