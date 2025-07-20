const WebSocket = require('ws');
const express = require('express');
const cors = require("cors");
require('dotenv').config();

// Import modular components
const { state, initializeState } = require('./modules/state');
const { subscriber } = require('./modules/redis');
const { setupRoutes } = require('./modules/routes');
const { setupWebSocket } = require('./modules/websocket');
const { setupMachineSocket } = require('./modules/udpSocket');

async function startServer() {
  try {
    // Initialize state first
    await initializeState();
    
    const app = express();
    app.use(cors());
    app.use(express.static('client'));
    app.use(express.json());

    // Setup API routes
    setupRoutes(app, state);

    app.listen(3000, () => {
      console.log(`Express API running on http://localhost:3000`);
    });

    const wss = new WebSocket.Server({ port: 3001 }, () => {
      console.log('WebSocket server started on ws://localhost:3001');
    });

    // Setup WebSocket handling (this also sets up subscriber message handling)
    setupWebSocket(wss, state);
    
    subscriber.subscribe('server_channel_sync');
    subscriber.subscribe('patched_info');

    // Setup machine socket for inter-server communication
    const machineSocket = setupMachineSocket(state);
    
    console.log("🚀 Server started successfully");
    
  } catch (err) {
    console.error("❌ Failed to start server:", err);
    process.exit(1);
  }
}

// Start the server
startServer();


