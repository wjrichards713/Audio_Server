const WebSocket = require('ws');
const { redis, publisher, subscriber } = require('../config/redis');
const { patchedGroups, patchedChannelSet } = require('./patching');

const activeRedisSubscriptions = new Set();

function initializeRedisSubscriber(wss) {
  subscriber.subscribe('servers');
  subscriber.subscribe('patched_info');

  subscriber.on("message", async (channel_id, data) => {
    const { servers, members } = require('./websocket');
    
    if(channel_id == 'servers') {
      console.log("Global Redis Message", {channel_id, data});
      const channel_servers = await redis.smembers("server_"+data);
      if(channel_servers && channel_servers.length) {
        servers[data] = channel_servers;
      } else {
        delete servers[data];
      }
      return;
    }

    if (channel_id == 'patched_info') {
      const { initializePatchedData } = require('./patching');
      await initializePatchedData();
      
      const {type, channels} = JSON.parse(data);
      const sortedNew = [...channels].sort();
      
      if(type==="PATCH"){
        const users_connected_set = new Set();
        for (const ch of sortedNew) {
          const memberData = await redis.hvals("member_" + ch);
          console.log("🚀 ~ subscriber.on ~ memberData:", memberData)
          memberData.map(JSON.parse).forEach(item => users_connected_set.add(item.user_name));
        }
        const users_connected = [...users_connected_set];
        console.log("🚀 ~ subscriber.on ~ users_connected:", users_connected)
        
        for (const ch of sortedNew) {
          if (members[ch]) {
            wss.clients.forEach((client) => {
              if (client.readyState === WebSocket.OPEN && members[ch].includes(client.websocketId)) {
                client.send(JSON.stringify({ channel_id: ch, users_connected: users_connected }));
              }
            });
          }
        }
        console.log("Added new patched group:", sortedNew);

      } else if (type === "UNPATCH") {
        for (const ch of sortedNew) {
          const users = new Set();
          const memberData = await redis.hvals("member_" + ch);
          memberData.map(JSON.parse).forEach(item => users.add(item.user_name));
          const users_connected = [...users];
      
          if (members[ch]) {
            wss.clients.forEach((client) => {
              if (client.readyState === WebSocket.OPEN && members[ch].includes(client.websocketId)) {
                client.send(JSON.stringify({
                  channel_id: ch,
                  users_connected: users_connected,
                }));
              }
            });
          }
        }
        console.log("Removed patched group:", sortedNew);
      }
      return;
    }

    const {message, websocketId} = JSON.parse(data);
    console.log("Redis Message", {message, websocketId});

    let targetChannels = [channel_id];
    
    for (const group of patchedGroups) {
      if (group.includes(channel_id)) {
        targetChannels = group;
        break;
      }
    }
    
    const users_connected_set = new Set();
    for (const ch of targetChannels) {
      patchedChannelSet.add(ch);
      const memberData = await redis.hvals("member_" + ch);
      console.log("🚀 ~ subscriber.on ~ memberData:", memberData)
      memberData.map(JSON.parse).forEach(item => users_connected_set.add(item.user_name));
    }
    const users_connected = [...users_connected_set];
    
    if(message.connect) {
      for (const ch of targetChannels) {
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN && members[ch]?.includes(client.websocketId)) {
            if(client.websocketId != websocketId) {
              client.send(JSON.stringify({ ch, users_connected: users_connected }));
            } else {
              client.send(JSON.stringify({ ch, users_connected: users_connected }));
            }
          }
        });
      }
    } else if (message.disconnect) {
      for (const ch of targetChannels) {
        if(members[ch]) {
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN && members[ch]?.includes(client.websocketId) && client.websocketId != websocketId) {
              client.send(JSON.stringify({ channel_id, users_connected: users_connected }));
            }
          });
        } else {
          console.log("Unsubscribing, ", channel_id);
          const serverAddress = `${global.serverPublicIP}:3002`;
          await redis.srem("server_"+channel_id, serverAddress);
          await subscriber.unsubscribe(channel_id);
          await publisher.publish('servers', channel_id);
          activeRedisSubscriptions.delete(channel_id);
          delete members[channel_id];
        }
      }
    } else if(channel_id) {
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && members[channel_id]?.includes(client.websocketId) && client.websocketId != websocketId) {
          client.send(JSON.stringify(message));
        }
      });
    }
  });
}

module.exports = {
  initializeRedisSubscriber,
  activeRedisSubscriptions
};