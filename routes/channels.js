const express = require('express');
const { redis } = require('../config/redis');
const router = express.Router();

async function getChannel(channelId) {
  const raw = await redis.hget('channels', channelId);
  return raw ? JSON.parse(raw) : null;
}

router.get("/", async (req, res) => {
  try {
    const channels = await redis.hgetall('channels');
    
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

router.post("/", async (req, res) => {
  try {
    const channelData = req.body;
    console.log("🚀 ~ app.post ~ channelData:", channelData)
    
    if (!channelData || !channelData.channel_id) {
      return res.status(400).json({ error: "Missing required channel_id field" });
    }
    
    const channelId = channelData.channel_id.toString();
    
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

router.delete("/:channelId", async (req, res) => {
  try {
    const { channelId } = req.params;
    
    const channel = await getChannel(channelId);
    if (!channel) {
      return res.status(404).json({ error: "Channel not found" });
    }
    
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

module.exports = { router, getChannel };