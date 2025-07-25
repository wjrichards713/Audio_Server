const express = require('express');

function createChannelRoutes(redis, publisher) {
  const router = express.Router();
  const getChannel = async (id) => JSON.parse(await redis.hget('channels', id) || 'null');

  // GET all channels
  router.get("/", async (req, res) => {
    try {
      const channels = await redis.hgetall('channels');
      res.json(Object.fromEntries(
        Object.entries(channels).map(([id, data]) => [id, JSON.parse(data)])
      ));
    } catch (err) {
      console.error("Error fetching channels:", err);
      res.status(500).json({ error: "Failed to retrieve channels" });
    }
  });

  // GET a single channel
  router.get("/:channelId", async (req, res) => {
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
  router.post("/", async (req, res) => {
    try {
      let channels = [];
      if (Array.isArray(req.body)) {
        // Validate each object in the array
        for (const ch of req.body) {
          if (!ch?.channel_id) {
            return res.status(400).json({ error: "Missing required channel_id in one or more objects" });
          }
          channels.push(ch);
        }
      } else if (req.body?.channel_id) {
        channels.push(req.body);
      } else {
        return res.status(400).json({ error: "Missing required channel_id field" });
      }
      const redisMap = {};
      for (const ch of channels) {
        redisMap[ch.channel_id.toString()] = JSON.stringify(ch);
      }
      await redis.hset('channels', redisMap);
      res.status(201).json({
        message: "Channel(s) created/updated successfully",
        channels: channels
      });
    } catch (err) {
      console.error("Error creating/updating channel:", err);
      res.status(500).json({ error: "Failed to create/update channel(s)" });
    }
  });

  // DELETE a channel
  router.delete("/:channelId", async (req, res) => {
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

  // PATCH channels
  router.post("/patch", async (req, res) => {
    const { channels } = req.body;
    if (!channels || channels.length < 2) {
      return res.status(400).json({ error: "Provide at least two channels." });
    }
    try {
      publisher.publish('patchings', JSON.stringify({type: 'PATCH', channels}));
      res.json({ message: "Channels patched successfully." });
    } catch (err) {
      console.error("Patch error:", err);
      res.status(500).json({ error: "Patch failed." });
    }
  });

  // UNPATCH channels
  router.post("/unpatch", async (req, res) => {
    const { channels } = req.body;
    if (!Array.isArray(channels) || channels.length === 0) {
      return res.status(400).json({ error: "Provide channels to unmerge." });
    }
    try {
      publisher.publish('patchings', JSON.stringify({type: 'UNPATCH', channels}));
      res.json({ message: "Channels unpatched successfully." });
    } catch (err) {
      console.error("Unmerge error:", err);
      res.status(500).json({ error: "Failed to unmerge." });
    }
  });

  return router;
}

module.exports = createChannelRoutes;