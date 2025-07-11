const WebSocket = require('ws');
const { redis, publisher, subscriber } = require('../config/redis');
const { getChannel } = require('../routes/channels');
const { createSocket } = require('./udp');

const members = {};
const servers = {};

function initializeWebSocketServer() {
  const wss = new WebSocket.Server({ port: 3001 }, () => {
    console.log('WebSocket server started on ws://localhost:3001');
  });

  wss.on('connection', async (socket, req) => {
    console.log('WebSocket User Connected', req.url);
    const queryParams = new URL(`http://localhost${req.url}`).searchParams;
    const websocketId = queryParams.get('websocket_id');
    socket.websocketId = websocketId;
    
    const { udpSockets } = require('./udp');
    
    try {
      udpSockets[websocketId].address();
    } catch ($e) {
      await createSocket(websocketId);
    }
    
    socket.on('message', async (message) => {
      message = message instanceof Buffer ? message.toString('utf-8') : message;
      try {
        message = JSON.parse(message);
        console.log("Websocket Message", message);

        if(message.connect) {
          const {channel_id} = message.connect;
          if(!await getChannel(channel_id)) {
            console.log("channel not got");
            return;
          }
          console.log("got channel");
          try {
            udpSockets[websocketId].address();
          } catch ($e) {
            await createSocket(websocketId);
          }
          members[channel_id] = [...(members[channel_id] || []).filter((port) => port != websocketId), websocketId];
          console.log("-------------",members[channel_id] )
          const serverAddress = `${global.serverPublicIP}:3002`;
          await redis.hset("member_" + channel_id, `${global.serverPublicIP}:${websocketId}`, JSON.stringify(message.connect));
          await redis.sadd("server_" + channel_id, serverAddress);
          await publisher.publish('servers', channel_id);
          
          const { activeRedisSubscriptions } = require('./redis-subscriber');
          if (!activeRedisSubscriptions.has(channel_id)) {
            await subscriber.subscribe(channel_id);
            activeRedisSubscriptions.add(channel_id);
          }
          await publisher.publish(channel_id, JSON.stringify({message, websocketId}));

        } else if(message.disconnect) {
          const {channel_id} = message.disconnect;
          members[channel_id] = (members[channel_id] || []).filter((port) => port != websocketId);
          await redis.hdel(
            "member_" + channel_id,
            `${global.serverPublicIP}:${websocketId}`
          );
          publisher.publish(channel_id, JSON.stringify({message, websocketId}));

        } else {
          for (const key in message) {
            if (Object.prototype.hasOwnProperty.call(message, key)) {
              const {channel_id} = message[key];
              publisher.publish(channel_id, JSON.stringify({message, websocketId}));
            }
          }
        }
      } catch ($e) {
        console.log($e);
      }
    });
    
    socket.on('close', async () => {
      console.log('WebSocket User Disconnected', req.url);
      const channels = Object.keys(members);
      channels.forEach(async (channel_id) => {
        if(members[channel_id].includes(websocketId)) {
          members[channel_id] = (members[channel_id] || []).filter((port) => port != websocketId);
          const user = JSON.parse(await redis.hget("member_" + channel_id, `${global.serverPublicIP}:${websocketId}`));
          await redis.hdel(
            "member_" + channel_id,
            `${global.serverPublicIP}:${websocketId}`
          );
          publisher.publish(channel_id, JSON.stringify({message: {disconnect: {...user, channel_id}}, websocketId}));
        }
      });
      
      const { udpSockets } = require('./udp');
      udpSockets[websocketId] && udpSockets[websocketId].close();
    });
  });

  return wss;
}

module.exports = {
  initializeWebSocketServer,
  members,
  servers
};