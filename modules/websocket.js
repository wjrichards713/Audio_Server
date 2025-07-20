const WebSocket = require('ws');
const { getPublicIP } = require('./utils');
const { redis, publisher, subscriber, getChannel } = require('./redis');
const { createSocket } = require('./udpSocket');

function setupWebSocket(wss, state) {
  const { udpSockets, udpClients, members, servers, redis_channel_subscriptions, serverPublicIP } = state;
  
  // Set up subscriber message handling
  subscriber.on("message", async (event_name, data) => {

    switch (event_name) {
      case 'server_channel_sync': {
        const channel_id = data;
        const channel_servers = await redis.smembers(`${channel_id}_servers`);
        if(channel_servers && channel_servers.length) {
          servers[channel_id] = channel_servers;
        } else {
          delete servers[channel_id];
        }
        return;
      }
      default: {
        const channel_id = event_name;
        const {message, websocketId} = JSON.parse(data);
        if(message.connect) {
          const users_connected = [...new Set((await redis.hvals(`${channel_id}_members`)).map(JSON.parse))];
          wss.clients.forEach((client) => {
            if(client.readyState === WebSocket.OPEN && members[channel_id].includes(client.websocketId)) {
              if(client.websocketId != websocketId) {
                client.send(JSON.stringify({ channel_id, users_connected: users_connected }));
              } else {
                client.send(JSON.stringify({ channel_id, users_connected: users_connected }));
              }
            }
          })
          return;
        }
        if(message.disconnect) {
          if(members[channel_id].length) {
            const users_connected = [...new Set((await redis.hvals(`${channel_id}_members`)).map(JSON.parse))];
            wss.clients.forEach((client) => {
              if (client.readyState === WebSocket.OPEN && members[channel_id].includes(client.websocketId) && client.websocketId != websocketId) {
                client.send(JSON.stringify({ channel_id, users_connected: users_connected }));
              }
            });
          } else {
            console.log("Unsubscribing, ", channel_id);
            await redis.srem(`${channel_id}_servers`, `${state.serverPublicIP}:3002`);
            await subscriber.unsubscribe(channel_id);
            await publisher.publish('server_exited_channel', channel_id);
            redis_channel_subscriptions.delete(channel_id);
            delete members[channel_id];
            delete servers[channel_id];
          }
        } else {
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN && members[channel_id].includes(client.websocketId) && client.websocketId != websocketId) {
              client.send(JSON.stringify(message));
            }
          });
        }
      }
    }
  });

  wss.on('connection', async (socket, req) => {
    console.log('WebSocket User Connected', req.url);
    try {
      state.serverPublicIP = await getPublicIP();
    } catch ($e) {
      console.error("Error detecting public IP:", $e);
      socket.close();
      return;
    }
    const {socket: udpSocket, port: websocketId} = await createSocket(0, state);
    socket.websocketId = websocketId;
    setInterval(() => {
      socket.send([]);
    }, 50000);
    socket.send(JSON.stringify({
      udp_port: websocketId,
      udp_host: state.serverPublicIP,
      websocket_id: websocketId,
      aes_key: "N/A"
    }));
    try {
      udpSockets[websocketId].address();
    } catch ($e) {
      await createSocket(websocketId, state);
    }
    socket.on('message', async (message) => {
      message = message instanceof Buffer ? message.toString('utf-8') : message;
      console.log("WSS:", message);
      try {
        message = JSON.parse(message);
        if(message.connect) {
          const { channel_id } = message.connect;
          delete message.connect.channel_id;
          if(!await getChannel(channel_id)) {
            console.log(`User ${websocketId} tried to connect to ${channel_id} but channel is not yet registered`);
            socket.send(JSON.stringify({
              error: true,
              message: `Channel ${channel_id} does not exist`,
              code: "CHANNEL_NOT_FOUND"
            }));
            return;
          }
          try {
            udpSockets[websocketId].address();
          } catch ($e) {
            await createSocket(websocketId, state);
          }
          members[channel_id] = [...(members[channel_id] || []).filter((port) => port != websocketId), websocketId];
          await redis.hset(`${channel_id}_members`, `${state.serverPublicIP}:${websocketId}`, JSON.stringify(message.connect));
          await redis.sadd(`${channel_id}_servers`, `${state.serverPublicIP}:3002`);
          await publisher.publish('server_channel_sync', channel_id);
          if (!redis_channel_subscriptions.has(channel_id)) {
            await subscriber.subscribe(channel_id);
            redis_channel_subscriptions.add(channel_id);
          }
          await publisher.publish(channel_id, JSON.stringify({message, websocketId}));
        } else if(message.disconnect) {
          const { channel_id } = message.disconnect;
          members[channel_id] = (members[channel_id] || []).filter((port) => port != websocketId);
          await redis.hdel(`${channel_id}_members`, `${state.serverPublicIP}:${websocketId}`);
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
    socket.on('close', async (e) => {
      console.log('WebSocket User Disconnected', req.url, e);
      const channels = Object.keys(members);
      channels.forEach(async (channel_id) => {
        if(members[channel_id].includes(websocketId)) {
          members[channel_id] = (members[channel_id] || []).filter((port) => port != websocketId);
          const user = JSON.parse(await redis.hget(`${channel_id}_members`, `${state.serverPublicIP}:${websocketId}`));
          await redis.hdel(`${channel_id}_members`, `${state.serverPublicIP}:${websocketId}`);
          publisher.publish(channel_id, JSON.stringify({message: {disconnect: {...user, channel_id}}, websocketId}));
        }
      });
      udpSockets[websocketId] && udpSockets[websocketId].close();
    });
  });
}

module.exports = {
  setupWebSocket
};