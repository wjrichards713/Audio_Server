const WebSocket = require('ws');
const { getPublicIP } = require('./utils');
const { createSocket } = require('./udp');
const {
  AutoScalingClient,
  DescribeAutoScalingInstancesCommand,
  DescribeAutoScalingGroupsCommand,
  UpdateAutoScalingGroupCommand,
  EnterStandbyCommand,
  ExitStandbyCommand,
} = require("@aws-sdk/client-auto-scaling");

const http = require("http");
const { execFile } = require("node:child_process");
const fs = require("node:fs");

// Redis keys (must match system.js)
const SERVER_STATUS_KEY   = "server_status";
const SERVER_VERSIONS_KEY = "server_versions";
const LATEST_VERSION_KEY  = "version_details";

// Drain behavior (tune if you want)
const UPDATE_MAX_DRAIN_MS = parseInt(process.env.UPDATE_MAX_DRAIN_MS || "60000", 10); // 60s
const UPDATE_TICK_MS      = parseInt(process.env.UPDATE_TICK_MS || "5000", 10);       // 5s


async function getRegionAndInstanceId() {
  // 1. Get IMDSv2 token
  const token = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: "PUT",
        host: "169.254.169.254",
        path: "/latest/api/token",
        headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
        timeout: 1000,
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

  // 2. Fetch the instance identity doc (region + instanceId, etc.)
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: "GET",
        host: "169.254.169.254",
        path: "/latest/dynamic/instance-identity/document",
        headers: { "X-aws-ec2-metadata-token": token },
        timeout: 1000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const doc = JSON.parse(data);
            resolve({
              region: doc.region,
              instanceId: doc.instanceId,
              accountId: doc.accountId,   // extra info if you need it
              availabilityZone: doc.availabilityZone
            });
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

async function enterStandbyNoReplacement({ region, instanceId }) {
  const asg = new AutoScalingClient({ region });

  const { AutoScalingInstances = [] } = await asg.send(
    new DescribeAutoScalingInstancesCommand({ InstanceIds: [instanceId] })
  );
  if (!AutoScalingInstances.length) {
    throw new Error(`Instance ${instanceId} is not in any Auto Scaling Group`);
  }
  const AutoScalingGroupName = AutoScalingInstances[0].AutoScalingGroupName;

  await asg.send(new EnterStandbyCommand({
    AutoScalingGroupName,
    InstanceIds: [instanceId],
    ShouldDecrementDesiredCapacity: true, // 👈 no replacement while updating
  }));

  return { AutoScalingGroupName };
}

async function exitStandbyRestoreCapacity({ region, instanceId, autoScalingGroupName }) {
  const asg = new AutoScalingClient({ region });

  const { AutoScalingGroups = [] } = await asg.send(
    new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [autoScalingGroupName] })
  );
  const group = AutoScalingGroups[0];
  if (!group) throw new Error(`ASG ${autoScalingGroupName} not found`);

  const desired = group.DesiredCapacity ?? 0;
  const maxSize = group.MaxSize ?? desired;

  if (desired+1 > maxSize) {
    await asg.send(new UpdateAutoScalingGroupCommand({
      AutoScalingGroupName: autoScalingGroupName,
      MaxSize: desired + 1
    }));
  }

  await asg.send(new ExitStandbyCommand({
    AutoScalingGroupName: autoScalingGroupName,
    InstanceIds: [instanceId]
  }));

  return { desiredBefore: currentDesired, desiredAfter: desired + 1 };
}


async function getLatestFromRedis(redis) {
  const raw = await redis.get(LATEST_VERSION_KEY);
  if (!raw) throw new Error(`No ${LATEST_VERSION_KEY} set`);
  let latest;
  try { latest = JSON.parse(raw); } catch { throw new Error(`Invalid JSON in ${LATEST_VERSION_KEY}`); }
  if (!latest.version || !latest.zipFile) throw new Error(`'version_details' missing version/zipFile`);
  return latest; 
}

async function getPreviousServerVersion(redis, ip) {
  const raw = await redis.hget(SERVER_VERSIONS_KEY, ip);
  if (raw) {
    try {
      const j = JSON.parse(raw);
      if (j.version && j.zipFile) return { version: j.version, zipFile: j.zipFile };
    } catch {}
  }
  const rawStatus = await redis.hget(SERVER_STATUS_KEY, ip);
  if (rawStatus) {
    try {
      const s = JSON.parse(rawStatus);
      if (s.version && s.zipFile) return { version: s.version, zipFile: s.zipFile };
    } catch {}
  }
  return null;
}

async function writeServerVersionToRedis(redis, ip, { version, zipFile, sourceUpdatedAt }) {
  const now = Date.now();

  const payload = { ip, version, zipFile, sourceUpdatedAt: sourceUpdatedAt || null, updatedAt: now };
  await redis.hset(SERVER_VERSIONS_KEY, ip, JSON.stringify(payload));

  const rawStatus = await redis.hget(SERVER_STATUS_KEY, ip);
  if (rawStatus) {
    let obj;
    try { obj = JSON.parse(rawStatus); } catch { obj = { ip }; }
    obj.version = version;
    obj.zipFile = zipFile;
    obj.versionUpdatedAt = now;
    await redis.hset(SERVER_STATUS_KEY, ip, JSON.stringify(obj));
  }

  return payload;
}

// --- placeholders for your real update/rollback scripts ---
async function performLocalUpdate({ version, zipFile }) {
  console.log("Updated Performed: ", "version", version, "zipFile", zipFile);
  // Replace with your real steps (download, unpack, restart, health-check)
  // await exec(`/usr/local/bin/update-app.sh ${version} ${zipFile}`);
  // Optionally: await exec(`/usr/local/bin/health-check.sh`);
}

async function performRollbackToPrevious({ version, zipFile }) {
  console.log("Rollback ro previous: ", "version", version, "zipFile", zipFile);
  // await exec(`/usr/local/bin/rollback-app.sh ${version} ${zipFile}`);
  // Optionally: await exec(`/usr/local/bin/health-check.sh`);
}

async function updateAndReattachWithRollback({ redis }) {
  const { region, instanceId } = await getRegionAndInstanceId();
  const ip = global.serverPublicIP;

  // 1) Stop new LB traffic; no replacement (desired -1)
  const { AutoScalingGroupName } = await enterStandbyNoReplacement({ region, instanceId });

  const latest   = await getLatestFromRedis(redis);
  const previous = await getPreviousServerVersion(redis, ip);

  try {
    // 2) Try update
    await performLocalUpdate({ version: latest.version, zipFile: latest.zipFile });

    // 3) Rejoin: restore desired (+1) & exit standby
    await exitStandbyRestoreCapacity({ region, instanceId, autoScalingGroupName: AutoScalingGroupName });

    // 4) Bookkeeping (this server now runs latest)
    await writeServerVersionToRedis(redis, ip, {
      version: latest.version,
      zipFile: latest.zipFile,
      sourceUpdatedAt: latest.updatedAt
    });

    return { success: true, rolledBack: false, latest, previous };
  } catch (err) {
    console.error("Update failed, attempting rollback:", err);

    if (!previous) {
      // No previous to roll back to → keep in Standby for safety (manual intervention)
      return { success: false, rolledBack: false, error: "No previous version to roll back to", latest, previous: null };
    }

    try {
      // Roll back
      await performRollbackToPrevious({ version: previous.version, zipFile: previous.zipFile });

      // Rejoin capacity & exit standby
      await exitStandbyRestoreCapacity({ region, instanceId, autoScalingGroupName: AutoScalingGroupName });

      // Ensure Redis shows the old version as current
      await writeServerVersionToRedis(redis, ip, {
        version: previous.version,
        zipFile: previous.zipFile,
        sourceUpdatedAt: null
      });

      return { success: false, rolledBack: true, latest, previous };
    } catch (rbErr) {
      console.error("Rollback failed:", rbErr);
      // Keep in Standby so it doesn't serve bad traffic
      return { success: false, rolledBack: false, error: `Rollback failed: ${rbErr.message}`, latest, previous };
    }
  }
}

async function startUpdate(wss, startedAt, redis, opts = {}) {
  const maxDrainMs = opts.maxDrainMs ?? UPDATE_MAX_DRAIN_MS;
  const tickMs     = opts.tickMs ?? UPDATE_TICK_MS;

  // Drain existing clients up to maxDrainMs
  const deadline = Date.now() + maxDrainMs;
  while (true) {
    const openClients = Array.from(wss.clients).filter(c => c.readyState === WebSocket.OPEN);
    const now = Date.now();

    openClients.forEach(c => c.send(JSON.stringify({ updating: true, updated: false, elapsedMs: now - startedAt })));

    if (openClients.length === 0 || now >= deadline) break;
    await new Promise(r => setTimeout(r, tickMs));
  }

  // Perform update with rollback handling (this will also restore desired & exit standby)
  const result = await updateAndReattachWithRollback({
    redis
  });

  // Notify any clients that connected meanwhile
  Array.from(wss.clients).filter(c => c.readyState === WebSocket.OPEN).forEach(c => {
    c.send(JSON.stringify({
      updating: false,
      updated: result.success,
      rolledBack: !!result.rolledBack,
      error: result.success ? undefined : (result.error || "Update failed; rollback attempted")
    }));
  });

  if (!result.success && !result.rolledBack) {
    console.error("Instance left in Standby due to failed update & rollback. Manual intervention required.");
  }
}


const getChannel = async (redis, id) => JSON.parse(await redis.hget('channels', id) || 'null');


let _shutdownStarted = false;

async function shutdownInstanceNow() {
  if (_shutdownStarted) return { status: "already-started" };
  _shutdownStarted = true;

  // Prefer explicit paths; fall back if needed.
  const candidates = ["/sbin/shutdown", "/usr/sbin/shutdown"];
  const cmd = candidates.find(p => fs.existsSync(p)) ?? "shutdown";
  const args = ["-h", "now"]; // halt (power off) now

  return new Promise((resolve, reject) => {
    execFile("sudo", [cmd, ...args], (err, stdout, stderr) => {
      if (err) {
        _shutdownStarted = false; // allow retry
        return reject(new Error(`Shutdown failed: ${stderr || err.message}`));
      }
      resolve({ status: "ok", stdout: String(stdout || "").trim() });
      // Machine will power off shortly; process will be killed by OS.
    });
  });
}

const detachInstance = async (publicIp) => {
  try {
    // Get both region and instanceId from IMDSv2 in one call
    console.log("detatch start");
    
    const { region, instanceId } = await getRegionAndInstanceId();

    const autoScalingClient = new AutoScalingClient({ region });

    // Check if *this* instance is part of an ASG
    const { AutoScalingInstances = [] } = await autoScalingClient.send(
      new DescribeAutoScalingInstancesCommand({ InstanceIds: [instanceId] })
    );

    if (!AutoScalingInstances.length) {
      return {
        success: false,
        error: `Instance ${instanceId} is not part of any Auto Scaling Group`,
        instanceId,
        region,
        publicIp
      };
    }

    const autoScalingGroupName = AutoScalingInstances[0].AutoScalingGroupName;

    // Detach self from the ASG without reducing desired capacity
    const detachResponse = await autoScalingClient.send(
      new DetachInstancesCommand({
        AutoScalingGroupName: autoScalingGroupName,
        InstanceIds: [instanceId],
        ShouldDecrementDesiredCapacity: true
      })
    );

    console.log("detatch done");

    return {
      success: true,
      instanceId,
      region,
      autoScalingGroupName,
      publicIp,
      scalingActivities: detachResponse.Activities || []
    };
  } catch (err) {
    console.error(err);
    return {
      success: false,
      error: err?.message || String(err)
    };
  }
};

async function startTermination(wss, time) {
  // console.log(wss.clients);

  var open_clients = Array.from(wss.clients).filter((client) => {
    console.log(client.readyState);
    
    return client.readyState === WebSocket.OPEN
  });
  // console.log(open_clients);
  if (open_clients.length) {
    const now = Date.now()
    open_clients.forEach((client) => {
      const isTerminated = now - time > 60000;
      const message = JSON.stringify({
        terminated: isTerminated,
        terminating: !isTerminated
      });
      client.send(message);
    })
    setTimeout(() => { startTermination(wss, time) }, 5000);
    console.log("open_clients.length: ", open_clients.length);
  }
  else {
    // aws terminate api call
    await shutdownInstanceNow();
    // terminateByPublicIp(region, global.serverPublicIP)
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
        console.log(global.serverPublicIP, data, "terminations", typeof(global.serverPublicIP), typeof(data), global.serverPublicIP == data);

        if (global.serverPublicIP == data) {
          console.log("processing detatch");

          //detatch 
          await detachInstance(data)

          startTermination(wss, Date.now());
        }
        return;
      }
      case 'update': {
        console.log("got update event");
        
        console.log(global.serverPublicIP, data, "update", typeof(global.serverPublicIP), typeof(data), global.serverPublicIP == data);

        if (global.serverPublicIP == data) {
          console.log("processing update");
          try {
            await startUpdate(wss, Date.now(), redis, {
              maxDrainMs: UPDATE_MAX_DRAIN_MS,
              tickMs: UPDATE_TICK_MS
            });
          } catch (e) {
            console.error("startUpdate error:", e);
          }
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