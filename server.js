const express = require('express');
const cors = require("cors");
const WebSocket = require('ws');
const dgram = require("dgram");
const Redis = require("ioredis");
require('dotenv').config();

const createChannelRoutes = require('./routes/channels');
const createSystemRoutes = require('./routes/system');
const websocketHandler = require('./modules/websocket');
const { setupUDP } = require('./modules/udp');
const redisSetup = require('./modules/redis');
const { getPublicIP } = require('./modules/utils');

// Initialize Express app
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('client'));

// Global state
global.udpSockets = {};
global.udpClients = {};
global.servers = {};
global.members = {};
global.patches = {};
global.serverPublicIP = null;

// Initialize server's public IP
(async () => {
  try {
    global.serverPublicIP = await getPublicIP();
    console.log(`Server's public IP initialized: ${global.serverPublicIP}`);
  } catch (err) {
    console.error("Failed to initialize server's public IP:", err);
  }
})();

// Setup Redis connections
const { redis, publisher, subscriber } = redisSetup();

// Routes
app.use('/channels', createChannelRoutes(redis, publisher));
app.use('/', createSystemRoutes(redis));

// WebSocket server
const wss = new WebSocket.Server({ port: 3001 }, () => {
  console.log('WebSocket server started on ws://localhost:3001');
});

// Setup WebSocket and UDP handlers
websocketHandler(wss, redis, publisher, subscriber);
setupUDP(redis, publisher, subscriber);

// Start Express server
app.listen(3000, () => {
  console.log(`Express API running on http://localhost:3000`);
});