const express = require('express');
const cors = require("cors");
const { getPublicIP } = require('./utils/http');
const { initializeWebSocketServer } = require('./services/websocket');
const { initializeMachineSocket } = require('./services/machine-socket');
const { initializePatchedData } = require('./services/patching');
const { initializeRedisSubscriber } = require('./services/redis-subscriber');

const channelRoutes = require('./routes/channels');
const systemRoutes = require('./routes/system');
const patchingRoutes = require('./routes/patching');

require('dotenv').config();

global.serverPublicIP = null;

(async () => {
  try {
    global.serverPublicIP = await getPublicIP();
    console.log(`Server's public IP initialized: ${global.serverPublicIP}`);
  } catch (err) {
    console.error("Failed to initialize server's public IP:", err);
  }
})();

const app = express();
app.use(cors());
app.use(express.static('client'));
app.use(express.json());

app.use('/channels', channelRoutes.router);
app.use('/channels', patchingRoutes);
app.use('/', systemRoutes);

app.listen(3000, () => {
  console.log(`Express API running on http://localhost:3000`);
});

const wss = initializeWebSocketServer();
initializeMachineSocket();
initializePatchedData();
initializeRedisSubscriber(wss);