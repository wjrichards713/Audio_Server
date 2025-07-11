const express = require('express');
const { publisher } = require('../config/redis');
const { patchChannels, unpatchChannels, savePatchedDataToRedis } = require('../services/patching');
const router = express.Router();

router.post("/patch", async (req, res) => {
  const { channels  } = req.body;
  if (!channels || channels.length < 2 ) {
    return res.status(400).json({ error: "Provide at least two channels." });
  }
  patchChannels(channels);

  try {
    await savePatchedDataToRedis();
    await publisher.publish("patched_info", JSON.stringify({"type": "PATCH", channels }));

    res.json({ message: "Channels patched successfully." });
  } catch (err) {
    console.error("Patch error:", err);
    res.status(500).json({ error: "Patch failed." });
  }
});

router.post("/unpatch", async (req, res) => {
  const { channels } = req.body;
  if (!channels) {
    return res.status(400).json({ error: "Provide channels to unmerge." });
  }
  unpatchChannels(channels);

  try {
    await savePatchedDataToRedis();
    await publisher.publish("patched_info", JSON.stringify({"type": "UNPATCH", channels }));

    res.json({ message: "Channels unpatched successfully." });
  } catch (err) {
    console.error("Unmerge error:", err);
    res.status(500).json({ error: "Failed to unmerge." });
  }
});

module.exports = router;