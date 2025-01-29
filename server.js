const dgram = require("dgram");
const fs = require('fs');
const express = require('express');
const WebSocket = require('ws');
const crypto = require('crypto'); // For AES decryption
const OpusScript = require('opusscript');
const { spawn } = require('child_process');
const cors = require("cors")
require('dotenv').config();

if(fs.existsSync(("public/output.pcm"))) {
  fs.unlinkSync("public/output.pcm");
}
const rtpSender = dgram.createSocket("udp4");
const ffplayRtpPort = 5004; // Port to which ffplay will listen

// Initialize Opus decoder (48kHz, mono)
const opusDecoder = new OpusScript(48000, 1);
const app = express();
app.use(cors())

// AES key for decryption
const aesKey = Buffer.from(process.env.AES_KEY, "base64"); // Replace with actual Base64 key
const ivLength = 12; // GCM recommended IV size is 12 bytes
// Create a WebSocket server on port 8080
const wss = new WebSocket.Server({ port: 3001 }, () => {
  console.log('WebSocket server started on ws://localhost:3001');
});

const available_ports = JSON.parse(fs.readFileSync(__dirname + '/available_ports.json', 'utf8'));
const port_registered = {};
const sockets_registered = {};
const users_registered = { '555': [], '666': [] };
const channel_ports = {
  '555': [8000, 8001, 8002, 8003, 8004],
  '666': []
};
let findPortIndex = 0;
wss.on('connection', (socket, req) => {
  console.log('New client connected', req.url);
  const queryParams = new URL(`http://localhost${req.url}`).searchParams;
  const websocketId = queryParams.get('websocket_id');
  sockets_registered[websocketId] = socket;
  // Handle incoming messages from clients
  socket.on('message', (message) => {
    const receivedMessage = message instanceof Buffer ? message.toString('utf-8') : message;
    try {
      var msg = JSON.parse(receivedMessage);
      if(msg.connect) {
        users_registered[websocketId] = {...msg.connect, port: websocketId}
      }
    } catch ($e) {

    }
    // Send a reply to the client
    socket.send(`Server received: ${receivedMessage}`);
  });

  // Handle client disconnect
  socket.on('close', () => {
      console.log('Client disconnected', req.url);
      delete sockets_registered[websocketId];
      delete users_registered[websocketId];
  });
});
// API to get available UDP ports for a given channel
app.get("/audio-server-port", (req, res) => {
  const availablePorts = available_ports.filter((port) => !port_registered[port]);   
  if (availablePorts.length > 0) {
    if(findPortIndex >= availablePorts.length) {
      findPortIndex = 0;
    } 
    res.json({ 
      udp_port: availablePorts[findPortIndex],
      websocket_id: availablePorts[findPortIndex].toString(),
      aes_key: "eyJhbGciOiJIUzI1eyJhbGciOiJIUzI1eyJhbGciOiJIUzI1"
    }); // Return the first available port
    findPortIndex++;
  } else {
    res.status(404).json({ message: "No available ports for this channel" });
  }
});
app.get("/audio-server-connected-users", (req, res) => {
  const channel_id = req.query.channel_id;
  res.json({
    "concurrent":1,
    "users": channel_ports[channel_id].map((port) => users_registered[port])
  })
});

// AES decryption function
function decryptAES(encryptedData, key) {
  const iv = encryptedData.slice(0, ivLength); // Extract IV from the first 12 bytes
  const encryptedPayload = encryptedData.slice(ivLength); // Remaining data is the payload

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(encryptedPayload.slice(-16)); // Extract the last 16 bytes as the authentication tag

  const decrypted = Buffer.concat([
    decipher.update(encryptedPayload.slice(0, -16)), // Decrypt the payload without the auth tag
    decipher.final(),
  ]);
  return decrypted;
}


// Start ffmpeg process
// const ffmpeg = spawn('ffmpeg', [
//   '-f', 's16le', '-ar', '48000', '-ac', '1', '-i', 'pipe:0', // Input from stdin
//   '-f', 'lavfi', '-i', 'anullsrc=cl=mono:r=48000',           // Silence for gaps
//   '-filter_complex', '[0:a]aresample=async=1:min_hard_comp=0.100:first_pts=0[aud];[aud][1:a]amix=inputs=2:duration=longest',
//   '-c:a', 'aac', '-b:a', '128k',
//   '-f', 'hls', '-hls_time', '2', '-hls_list_size', '10',
//   '-hls_flags', 'append_list',
//   'public/stream.m3u8'
// ]);

// ffmpeg.stderr.on('data', (data) => {
//   console.error(`FFmpeg error: ${data}`);
// });

// ffmpeg.on('close', (code) => {
//   console.log(`FFmpeg process exited with code ${code}`);
// });


available_ports.forEach((port) => {
  const server = dgram.createSocket("udp4");
  server.on("message", (msg, rinfo) => {
    try {
      const data = JSON.parse(msg.toString('utf-8'));
      console.log(data);
      if (rinfo.address == '127.0.0.1' && port_registered[port]) {
        server.send(msg, port_registered[port].port, port_registered[port].address, (err) => {
          if (err) {
            console.error(`Failed to send to ${port_registered[port].address}:${port_registered[port].port}`, err);
          } else {
            console.log(`Forwarded packet to ${port_registered[port].address}:${port_registered[port].port}`);
          }
        });
      } else if (rinfo.address != '127.0.0.1' && data.channel_id) {
        port_registered[port] = rinfo;

        if (data && data.data) {
          // Decode Base64 to binary encrypted Opus
          const base64Decoded = Buffer.from(data.data, "base64");
          const decryptedData = decryptAES(base64Decoded, aesKey);
          const pcmBuffer = opusDecoder.decode(decryptedData);
          // console.log({base64Decoded , decryptedData, pcmBuffer});
          // fs.appendFileSync("public/output.pcm", pcmBuffer);
          // // Write PCM data directly to FFmpeg
          // if (ffmpeg.stdin.writable) {
          //     ffmpeg.stdin.write(pcmBuffer);
          // } else {
          //     console.error('FFmpeg stdin is not writable');
          // }
        }

        channel_ports[data.channel_id].forEach((p) => {
          if(p != port) {
            server.send(msg, p, 'localhost', (err) => {
              if (err) {
                console.error(`Failed to send to localhost:${p}`, err);
              } else {
                console.log(`Forwarded packet to localhost:${p}`);
              }
            });
          }
        });
      } else if(rinfo.address != '127.0.0.1') {
        port_registered[port] = rinfo;
      }
    } catch ($e) {
      console.error($e);
    }
  });
  server.bind(port, () => {
    console.log(`Server listening on port ${port}`);
  });
});
app.use(express.static('public'));
app.use(express.static('client'));
// // app.use(express.static(path.join(__dirname, 'client')));
// app.use(express.static(path.join(__dirname, 'client')));
// app.get('/', (req, res) => {
//   res.sendFile(path.join(__dirname, 'client', 'client.html'));
// })
app.listen(3000, () => {
  console.log(`Express API running on http://localhost:3000`);
});