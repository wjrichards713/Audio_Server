const WebSocket = require('ws');
const { getPublicIP } = require('./utils');
const { createSocket } = require('./udp');
const { EC2Client, DescribeInstancesCommand, TerminateInstancesCommand } = require('@aws-sdk/client-ec2');
const { AutoScalingClient, DetachInstancesCommand, DescribeAutoScalingInstancesCommand } = require('@aws-sdk/client-auto-scaling');
const http =  require("http");

async function getRegion() {
  // Get a token (IMDSv2)
  const token = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: "PUT",
        host: "169.254.169.254",
        path: "/latest/api/token",
        headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
        timeout: 1000
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", reject);
    req.end();
  });

  // Use token to query region
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: "GET",
        host: "169.254.169.254",
        path: "/latest/dynamic/instance-identity/document",
        headers: { "X-aws-ec2-metadata-token": token },
        timeout: 1000
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const doc = JSON.parse(data);
            resolve(doc.region); // <- region here
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}


const getChannel = async (redis, id) => JSON.parse(await redis.hget('channels', id) || 'null');

async function terminateByPublicIp({ region, publicIp }) {
  if (!region || !publicIp) throw new Error("region and publicIp are required");

  const ec2 = new EC2Client({ region });

  // 1. Find instance ID by public IP
  const di = await ec2.send(new DescribeInstancesCommand({
    Filters: [
      { Name: "ip-address", Values: [publicIp] },
      { Name: "instance-state-name", Values: ["pending","running","stopped","stopping"] }
    ]
  }));

  const iid = di.Reservations?.[0]?.Instances?.[0]?.InstanceId;
  if (!iid) throw new Error(`No EC2 instance found with public IP ${publicIp} in ${region}`);

  console.log(`Resolved ${publicIp} → InstanceId=${iid}`);

  // 2. Terminate the instance
  const resp = await ec2.send(new TerminateInstancesCommand({
    InstanceIds: [iid]
  }));

  return resp.TerminatingInstances || [];
}

const detachInstance = async (publicIp) => {

  const region = await getRegion();
  // Initialize AWS clients - credentials should be provided via environment variables or IAM role
  const ec2Client = new EC2Client({ region: region });
  const autoScalingClient = new AutoScalingClient({ region: region });

  // Step 1: Find the EC2 instance by public IP
  const describeInstancesCommand = new DescribeInstancesCommand({
    Filters: [
      {
        Name: 'ip-address',
        Values: [publicIp]
      },
      {
        Name: 'instance-state-name',
        Values: ['running', 'stopped', 'stopping']
      }
    ]
  });

  const instancesResponse = await ec2Client.send(describeInstancesCommand);

  if (!instancesResponse.Reservations || instancesResponse.Reservations.length === 0) {
    return res.status(404).json({
      error: `No EC2 instance found with public IP: ${publicIp}`,
      success: false
    });
  }

  const instance = instancesResponse.Reservations[0].Instances[0];
  const instanceId = instance.InstanceId;

  // Step 2: Check if the instance is part of an Auto Scaling Group
  const describeAutoScalingInstancesCommand = new DescribeAutoScalingInstancesCommand({
    InstanceIds: [instanceId]
  });

  const asgInstancesResponse = await autoScalingClient.send(describeAutoScalingInstancesCommand);

  if (!asgInstancesResponse.AutoScalingInstances || asgInstancesResponse.AutoScalingInstances.length === 0) {
    return res.status(400).json({
      error: `Instance ${instanceId} is not part of any Auto Scaling Group`,
      instanceId,
      region,
      success: false
    });
  }

  const autoScalingInstance = asgInstancesResponse.AutoScalingInstances[0];
  const autoScalingGroupName = autoScalingInstance.AutoScalingGroupName;

  // Step 3: Detach the instance from the Auto Scaling Group
  const detachInstancesCommand = new DetachInstancesCommand({
    AutoScalingGroupName: autoScalingGroupName,
    InstanceIds: [instanceId],
    ShouldDecrementDesiredCapacity: shouldDecrementDesiredCapacity
  });

  const detachResponse = await autoScalingClient.send(detachInstancesCommand);


  return ({
    success: true,
    instanceId,
    region,
    autoScalingGroupName,
    publicIp,
    shouldDecrementDesiredCapacity,
    scalingActivities: detachResponse.Activities || []
  });
}

async function startTermination(wss, time) {
  console.log(wss.clients);

  var open_clients = Array.from(wss.clients).filter((client) => client.readyState === WebSocket.OPEN);
  if (open_clients.length) {
    const now = Date.now()
    open_clients.forEach((client) => {
      client.send(now - time > 60000 ? "terminated" : "terminating");
    })
    setTimeout(() => { startTermination(wss, time) }, 5000);
    console.log("open_clients.length ",open_clients.length);
  }
  else {
    // aws terminate api call
    const region = await getRegion();
    console.log("open_clients.length ", open_clients.length);
    terminateByPublicIp(region, global.serverPublicIP)
  }
}

function setupWebSocket(wss, redis, publisher, subscriber) {
  const redis_channel_subscriptions = new Set();

  subscriber.on("message", async (event_name, data) => {
    switch (event_name) {
      case 'server_channel_sync': {
        const channel_id = data;
        const channel_servers = await redis.smembers(`${channel_id}_servers`);
        if (channel_servers && channel_servers.length) {
          global.servers[channel_id] = channel_servers;
        } else {
          delete global.servers[channel_id];
        }
        return;
      }
      case 'terminations': {
        console.log(global.serverPublicIP, data, global.serverPublicIP == data);

        if (global.serverPublicIP == data) {
          console.log("processing detatch");
          
          //detatch 
          detachInstance(data)

          startTermination(wss, Date.now());
        }
        return;
      }
      case 'patchings': {
        const { type, channels } = JSON.parse(data);
        if (type == 'PATCH') {
          channels.forEach(async (channel) => {
            global.patches[channel] = Array.from(new Set([
              ...(global.patches[channel] || []),
              ...channels
            ]));
          });
          const users_connected = [...new Set((await Promise.all(channels.map(async (ch) => (await redis.hvals(`${ch}_members`)).map(JSON.parse)))).flat())];
          wss.clients.forEach((client) => {
            channels.forEach((channel_id) => {
              if (client.readyState === WebSocket.OPEN && (global.members[channel_id] || []).includes(client.websocketId)) {
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
                  if (client.readyState === WebSocket.OPEN && (global.members[channel_id] || []).includes(client.websocketId)) {
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
        const { message, websocketId } = JSON.parse(data);
        if (message.connect) {
          const users_connected = [...new Set((await Promise.all((global.patches[channel_id] || [channel_id]).map(async (ch) => (await redis.hvals(`${ch}_members`)).map(JSON.parse)))).flat())];
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN && (global.members[channel_id] || []).includes(client.websocketId)) {
              if (client.websocketId != websocketId) {
                client.send(JSON.stringify({ channel_id, users_connected: users_connected }));
              } else {
                client.send(JSON.stringify({ channel_id, users_connected: users_connected }));
              }
            }
          })
          return;
        }
        if (message.disconnect) {
          if ((global.members[channel_id] || []).length) {
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
    const { socket: udpSocket, port: websocketId } = await createSocket();
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
        if (message.connect) {
          const { channel_id } = message.connect;
          delete message.connect.channel_id;
          if (!await getChannel(redis, channel_id)) {
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
            await publisher.publish(channel_id, JSON.stringify({ message, websocketId }));
          })
        } else if (message.disconnect) {
          const { channel_id } = message.disconnect;
          global.members[channel_id] = (global.members[channel_id] || []).filter((port) => port != websocketId);
          await redis.hdel(`${channel_id}_members`, `${global.serverPublicIP}:${websocketId}`);
          (global.patches[channel_id] || [channel_id]).forEach(async (channel_id) => {
            if (message?.channel_id) { message.channel_id = channel_id; }
            Object.values(message).forEach(obj => { if (obj?.channel_id) { obj.channel_id = channel_id; } });
            await publisher.publish(channel_id, JSON.stringify({ message, websocketId }));
          })
        } else {
          for (const key in message) {
            if (Object.prototype.hasOwnProperty.call(message, key)) {
              const { channel_id } = message[key];
              (global.patches[channel_id] || [channel_id]).forEach(async (channel_id) => {
                if (message?.channel_id) { message.channel_id = channel_id; }
                Object.values(message).forEach(obj => { if (obj?.channel_id) { obj.channel_id = channel_id; } });
                await publisher.publish(channel_id, JSON.stringify({ message, websocketId }));
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
        if (global.members[channel_id].includes(websocketId)) {
          global.members[channel_id] = (global.members[channel_id] || []).filter((port) => port != websocketId);
          const user = JSON.parse(await redis.hget(`${channel_id}_members`, `${global.serverPublicIP}:${websocketId}`));
          await redis.hdel(`${channel_id}_members`, `${global.serverPublicIP}:${websocketId}`);
          (global.patches[channel_id] || [channel_id]).forEach(async (channel_id) => {
            publisher.publish(channel_id, JSON.stringify({ message: { disconnect: { ...user, channel_id } }, websocketId }));
          })
        }
      });
      global.udpSockets[websocketId] && global.udpSockets[websocketId].close();
    });
  });
}

module.exports = setupWebSocket;