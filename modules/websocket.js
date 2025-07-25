const WebSocket = require('ws');
const { getPublicIP } = require('./utils');
const { createSocket } = require('./udp');

const getChannel = async (redis, id) => JSON.parse(await redis.hget('channels', id) || 'null');

function setupWebSocket(wss, redis, publisher, subscriber) {
  const redis_channel_subscriptions = new Set();

  subscriber.on("message", async (event_name, data) => {
    switch (event_name) {
      case 'server_channel_sync': {
        const channel_id = data;
        const channel_servers = await redis.smembers(`${channel_id}_servers`);
        if(channel_servers && channel_servers.length) {
          global.servers[channel_id] = channel_servers;
        } else {
          delete global.servers[channel_id];
        }
        return;
      }
      case 'patchings': {
        const { type, channels } = JSON.parse(data);
        if(type == 'PATCH') {
          channels.forEach(async (channel) => {
            global.patches[channel] = Array.from(new Set([
              ...(global.patches[channel] || []),
              ...channels
            ]));
          });
          const users_connected = [...new Set((await Promise.all(channels.map(async (ch) => (await redis.hvals(`${ch}_members`)).map(JSON.parse)))).flat())];
          wss.clients.forEach((client) => {
            channels.forEach((channel_id) => {
              if(client.readyState === WebSocket.OPEN && (global.members[channel_id] || []).includes(client.websocketId)) {
                client.send(JSON.stringify({ channel_id, users_connected: users_connected }));
              }
            });
          });
        } else if (type == 'UNPATCH') {
          channels.forEach(async (channel) => {
            const filtered = Array.from(new Set(
              (global.patches[channel] || []).filter(c => !channels.includes(c) || c === channel)
            ));
            if (filtered.length > 0) {
              global.patches[channel] = filtered;
              const users_connected = [...new Set((await Promise.all(global.patches[channel].map(async (ch) => (await redis.hvals(`${ch}_members`)).map(JSON.parse)))).flat())];
              wss.clients.forEach((client) => {
                global.patches[channel].forEach((channel_id) => {
                  if(client.readyState === WebSocket.OPEN && (global.members[channel_id] || []).includes(client.websocketId)) {
                    client.send(JSON.stringify({ channel_id, users_connected: users_connected }));
                  }
                });
              });
            } else {
              delete global.patches[channel];
            }
          });
        }
        redis.set('patches', JSON.stringify(global.patches));
        return;
      }
      default: {
        const channel_id = event_name;
        const {message, websocketId} = JSON.parse(data);
        if(message.connect) {
          const users_connected = [...new Set((await Promise.all((global.patches[channel_id] || [channel_id]).map(async (ch) => (await redis.hvals(`${ch}_members`)).map(JSON.parse)))).flat())];
          wss.clients.forEach((client) => {
            if(client.readyState === WebSocket.OPEN && (global.members[channel_id] || []).includes(client.websocketId)) {
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
          if((global.members[channel_id] || []).length) {
            const users_connected = [...new Set((await Promise.all((global.patches[channel_id] || [channel_id]).map(async (ch) => (await redis.hvals(`${ch}_members`)).map(JSON.parse)))).flat())];
            wss.clients.forEach((client) => {
              if (client.readyState === WebSocket.OPEN && (global.members[channel_id] || []).includes(client.websocketId) && client.websocketId != websocketId) {
                client.send(JSON.stringify({ channel_id, users_connected: users_connected }));
              }
            });
          } else {
            console.log("Unsubscribing, ", channel_id);
            await redis.srem(`${channel_id}_servers`, `${global.serverPublicIP}:3002`);
            await subscriber.unsubscribe(channel_id);
            await publisher.publish('server_channel_sync', channel_id);
            redis_channel_subscriptions.delete(channel_id);
            delete global.members[channel_id];
          }
        } else {
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN && (global.members[channel_id] || []).includes(client.websocketId) && client.websocketId != websocketId) {
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
      global.serverPublicIP = await getPublicIP();
    } catch ($e) {
      console.error("Error detecting public IP:", $e);
      socket.close();
      return;
    }
    const {socket: udpSocket, port: websocketId} = await createSocket();
    socket.websocketId = websocketId;
    setInterval(() => {
      socket.send([]);
    }, 50000);
    socket.send(JSON.stringify({
      udp_port: websocketId,
      udp_host: global.serverPublicIP,
      websocket_id: websocketId,
      aes_key: "N/A"
    }));
    try {
      global.udpSockets[websocketId].address();
    } catch ($e) {
      await createSocket(websocketId);
    }
    socket.on('message', async (message) => {
      message = message instanceof Buffer ? message.toString('utf-8') : message;
      console.log("WSS:", message);
      try {
        message = JSON.parse(message);
        if(message.connect) {
          const { channel_id } = message.connect;
          delete message.connect.channel_id;
          if(!await getChannel(redis, channel_id)) {
            console.log(`User ${websocketId} tried to connect to ${channel_id} but channel is not yet registered`);
            socket.send(JSON.stringify({
              error: true,
              message: `Channel ${channel_id} does not exist`,
              code: "CHANNEL_NOT_FOUND"
            }));
            return;
          }
          try {
            global.udpSockets[websocketId].address();
          } catch ($e) {
            await createSocket(websocketId);
          }
          global.members[channel_id] = [...(global.members[channel_id] || []).filter((port) => port != websocketId), websocketId];
          await redis.hset(`${channel_id}_members`, `${global.serverPublicIP}:${websocketId}`, JSON.stringify(message.connect));
          await redis.sadd(`${channel_id}_servers`, `${global.serverPublicIP}:3002`);
          await publisher.publish('server_channel_sync', channel_id);
          if (!redis_channel_subscriptions.has(channel_id)) {
            await subscriber.subscribe(channel_id);
            redis_channel_subscriptions.add(channel_id);
          }
          (global.patches[channel_id] || [channel_id]).forEach(async (channel_id) => {
            await publisher.publish(channel_id, JSON.stringify({message, websocketId}));
          })
        } else if(message.disconnect) {
          const { channel_id } = message.disconnect;
          global.members[channel_id] = (global.members[channel_id] || []).filter((port) => port != websocketId);
          await redis.hdel(`${channel_id}_members`, `${global.serverPublicIP}:${websocketId}`);
          (global.patches[channel_id] || [channel_id]).forEach(async (channel_id) => {
            if (message?.channel_id) {message.channel_id = channel_id;}
            Object.values(message).forEach(obj => { if (obj?.channel_id) { obj.channel_id = channel_id; } });
            await publisher.publish(channel_id, JSON.stringify({message, websocketId}));
          })
        } else {
          for (const key in message) {
            if (Object.prototype.hasOwnProperty.call(message, key)) {
              const {channel_id} = message[key];
              (global.patches[channel_id] || [channel_id]).forEach(async (channel_id) => {
                if (message?.channel_id) {message.channel_id = channel_id;}
                Object.values(message).forEach(obj => { if (obj?.channel_id) { obj.channel_id = channel_id; } });
                await publisher.publish(channel_id, JSON.stringify({message, websocketId}));
              })
            }
          }
        }
      } catch ($e) {
        console.log($e);
      }
    });
    socket.on('close', async (e) => {
      console.log('WebSocket User Disconnected', req.url, e);
      const channels = Object.keys(global.members);
      channels.forEach(async (channel_id) => {
        if(global.members[channel_id].includes(websocketId)) {
          global.members[channel_id] = (global.members[channel_id] || []).filter((port) => port != websocketId);
          const user = JSON.parse(await redis.hget(`${channel_id}_members`, `${global.serverPublicIP}:${websocketId}`));
          await redis.hdel(`${channel_id}_members`, `${global.serverPublicIP}:${websocketId}`);
          (global.patches[channel_id] || [channel_id]).forEach(async (channel_id) => {
            publisher.publish(channel_id, JSON.stringify({message: {disconnect: {...user, channel_id}}, websocketId}));
          })
        }
      });
      global.udpSockets[websocketId] && global.udpSockets[websocketId].close();
    });
  });
}

module.exports = setupWebSocket;