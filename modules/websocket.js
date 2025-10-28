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
  DetachInstancesCommand
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

  console.log("standby exit done");
  

  return { desiredBefore: desired, desiredAfter: desired + 1 };
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

// helper (top of file, once)
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// --- placeholders for your real update/rollback scripts ---
// replace your current performLocalUpdate with this:
export async function performLocalUpdate({ version, zipFile, waitMs }) {
  const ctx = { tmpZip: null, TARGET: null, CURRENT: null, BASE: null, step: "init" };

  const log = (...args) => console.log("[deploy]", ...args);
  const fail = (step, err) => {
    const msg = (err && err.message) ? err.message : String(err);
    console.error(`[deploy] ❌ Failed at step: ${step}`);
    console.error(`[deploy] ${msg}`);
    if (err && err.stack) console.error(err.stack);
    return { ok: false, step, message: msg };
  };

  try {
    log("params:", { version, zipFile, waitMs });

    // ---- config & paths ----
    ctx.step = "config";
    const APP_NAME = process.env.APP_NAME || "server";
    const DEPLOY_BASE = process.env.DEPLOY_BASE || `/var/www/${APP_NAME}`;
    const PM2_NAME = process.env.PM2_NAME || APP_NAME;
    const START_FILE = process.env.START_FILE || "server.js";
    const NPM_BIN = process.env.NPM_BIN || "npm";
    const REGION = process.env.AWS_REGION || "ap-south-1";

    const BASE = DEPLOY_BASE;
    const RELEASES = path.join(BASE, "releases");
    const SHARED = path.join(BASE, "shared");
    const CURRENT = path.join(BASE, "current");
    ctx.BASE = BASE; ctx.CURRENT = CURRENT;

    fs.mkdirSync(RELEASES, { recursive: true });
    fs.mkdirSync(SHARED, { recursive: true });

    // ---- resolve S3 bucket & key ----
    ctx.step = "resolve-s3";
    let bucket = process.env.S3_BUCKET;
    let key = zipFile;
    if (!zipFile) throw new Error("zipFile not provided");
    if (zipFile.startsWith("s3://")) {
      const m = zipFile.match(/^s3:\/\/([^/]+)\/(.+)$/);
      if (!m) throw new Error(`Bad S3 URL: ${zipFile}`);
      bucket = m[1];
      key = m[2];
    }
    if (!bucket) throw new Error("S3 bucket missing. Set S3_BUCKET or pass s3://bucket/key");
    log(`S3 target: s3://${bucket}/${key}  (region=${REGION})`);

    // ---- S3 client (env/provider chain) ----
    ctx.step = "s3-client";
    const s3 = new S3Client({ region: REGION });

    // ---- download to tmp ----
    ctx.step = "download";
    const tmpZip = path.join(os.tmpdir(), `${APP_NAME}-${Date.now()}.zip`);
    ctx.tmpZip = tmpZip;
    log(`Downloading → ${tmpZip}`);
    let obj;
    try {
      obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    } catch (e) {
      throw new Error(`S3 GetObject failed for s3://${bucket}/${key}: ${e.message}`);
    }
    await pipeline(obj.Body, fs.createWriteStream(tmpZip));

    // ---- prepare new release dir ----
    ctx.step = "prepare-release";
    const stamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
    const releaseName = `${APP_NAME}-v${version || "unknown"}-${stamp}`;
    const TARGET = path.join(RELEASES, releaseName);
    ctx.TARGET = TARGET;
    fs.mkdirSync(TARGET, { recursive: true });

    // ---- unzip ----
    ctx.step = "unzip";
    log(`Unzipping into ${TARGET}`);
    try {
      await pipeline(fs.createReadStream(tmpZip), unzipper.Extract({ path: TARGET }));
    } catch (e) {
      throw new Error(`Unzip failed: ${e.message}`);
    } finally {
      try { fs.rmSync(tmpZip, { force: true }); } catch {}
    }

    // ---- link shared .env (if present) ----
    ctx.step = "link-env";
    const sharedEnv = path.join(SHARED, ".env");
    const targetEnv = path.join(TARGET, ".env");
    if (fs.existsSync(sharedEnv) && !fs.existsSync(targetEnv)) {
      try { fs.symlinkSync(sharedEnv, targetEnv); }
      catch (e) { throw new Error(`Linking .env failed: ${e.message}`); }
    }

    // ---- install production deps ----
    ctx.step = "npm-ci";
    log("Installing production deps…");
    try {
      await run(`${NPM_BIN}`, ["ci", "--omit=dev"], { cwd: TARGET });
    } catch (e) {
      throw new Error(`npm ci failed in ${TARGET}: ${e.message}`);
    }

    // ---- atomically switch "current" symlink ----
    ctx.step = "switch-symlink";
    const tempLink = path.join(BASE, `.current-${stamp}`);
    try {
      try { fs.unlinkSync(tempLink); } catch {}
      fs.symlinkSync(TARGET, tempLink);
      try {
        fs.renameSync(tempLink, CURRENT); // atomic (same fs)
      } catch {
        try { fs.unlinkSync(CURRENT); } catch {}
        fs.renameSync(tempLink, CURRENT);
      }
    } catch (e) {
      throw new Error(`Switching 'current' symlink failed: ${e.message}`);
    } finally {
      try { fs.unlinkSync(tempLink); } catch {}
    }

    // ---- PM2 reload or start ----
    ctx.step = "pm2";
    const startPath = path.join(CURRENT, START_FILE);
    if (!fs.existsSync(startPath)) {
      log(`⚠ START_FILE not found at ${startPath}. Continuing, but PM2 start may fail.`);
    }

    const pm2Exists = await pm2ProcessExists(PM2_NAME).catch(() => false);
    try {
      if (pm2Exists) {
        await run("pm2", ["reload", PM2_NAME, "--update-env"]);
      } else {
        await run("pm2", ["start", startPath, "--name", PM2_NAME]);
      }
    } catch (e) {
      throw new Error(`PM2 operation failed: ${e.message}`);
    }

    // optional post-wait
    if (Number.isFinite(waitMs) || process.env.DUMMY_UPDATE_WAIT_MS) {
      const ms = Number.isFinite(waitMs) ? waitMs : parseInt(process.env.DUMMY_UPDATE_WAIT_MS || "0", 10);
      if (ms > 0) { ctx.step = "post-wait"; log(`Sleeping ${ms}ms…`); await sleep(ms); }
    }

    log(`✅ Deployed ${APP_NAME} → ${TARGET}`);
    return { ok: true, message: `Deployed to ${TARGET}`, step: "done" };

  } catch (err) {
    return fail(ctx.step, err);
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", ...opts });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with ${code}`));
    });
  });
}

async function pm2ProcessExists(name) {
  try {
    await run("pm2", ["describe", name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
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
  // const { AutoScalingGroupName } = await enterStandbyNoReplacement({ region, instanceId });

  const latest   = await getLatestFromRedis(redis);
  const previous = await getPreviousServerVersion(redis, ip);

  try {
    // 2) Try update
    console.log("update start");

    await performLocalUpdate({ version: "1.0.3", zipFile: "s3://audio-redenes/apps/server/latest.zip" });

    console.log("update done");
    // 3) Rejoin: restore desired (+1) & exit standby
    // await exitStandbyRestoreCapacity({ region, instanceId, autoScalingGroupName: AutoScalingGroupName });

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
      // await exitStandbyRestoreCapacity({ region, instanceId, autoScalingGroupName: AutoScalingGroupName });

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
  console.log("inside shutdown");
  
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

    console.log("detatch done, ", detachResponse.Activities);

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
    console.log("shutdown start");
    
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

         // detatch
          const detachResult = await detachInstance(data);

          if (detachResult.success) {
            // Only proceed if detach was successful
            startTermination(wss, Date.now());
          } else {
            console.error("Detach failed, not starting termination:", detachResult.error);
            // Optionally, you could send back an error response here
          }
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