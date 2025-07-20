// Global application state
const state = {
  // Connection tracking
  udpSockets: {}, // Stores UDP sockets indexed by user's websocket ID
  udpClients: {}, // Stores UDP client information (rinfo) indexed by user's websocket ID
  servers: {}, // Tracks which servers are handling each channel
  members: {}, // Maps channel IDs to arrays of websocket IDs of connected users
  
  // Server info
  serverPublicIP: null,
  
  // Redis subscriptions
  redis_channel_subscriptions: new Set(),
  
  // Patching info
  patchedGroups: [],
  patchedChannelSet: new Set(),
  
  // Machine socket for inter-server communication
  machineSocket: null
};

// Initialize state from Redis
async function initializeState() {
  try {
    const { redis } = require('./redis');
    const { getPublicIP } = require('./utils');
    
    // Load server's public IP
    state.serverPublicIP = await getPublicIP();
    console.log(`Server's public IP initialized: ${state.serverPublicIP}`);
    
    // Load patched data
    const groupData = await redis.get("patched_groups");
    if (groupData) {
      state.patchedGroups = JSON.parse(groupData);
    }

    const channels = await redis.smembers("patched_channel_set");
    if (channels && channels.length > 0) {
      state.patchedChannelSet = new Set(channels);
    }
    
    console.log("✅ State initialized successfully");
    return state;
  } catch (err) {
    console.error("❌ Failed to initialize state:", err);
    throw err;
  }
}

module.exports = {
  state,
  initializeState
};