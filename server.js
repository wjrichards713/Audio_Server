const dgram = require("dgram");

// Server Configuration
const SERVER_PORT_A = 8000; // Port for server A
const SERVER_PORT_B = 8001; // Port for server B
let CLIENT_A_IP = '';
let CLIENT_A_PORT = '';
let CLIENT_B_IP = '';
let CLIENT_B_PORT = '';

// Create UDP sockets for both servers
const serverA = dgram.createSocket("udp4");
const serverB = dgram.createSocket("udp4");

// Helper function to add a marker to the message
function addMarker(msg) {
  return Buffer.concat([Buffer.from('SERVER_MARKER:'), msg]);
}

// Helper function to check and remove the marker
function removeMarker(msg) {
  const marker = 'SERVER_MARKER:';
  const msgStr = msg.toString();
  if (msgStr.startsWith(marker)) {
    return Buffer.from(msgStr.slice(marker.length));
  }
  return null; // Return null if no marker is found
}

// Handle incoming RTP packets on Server A
serverA.on("message", (msg, rinfo) => {
  console.log(`[serverA] Received packet from ${rinfo.address}:${rinfo.port}`);

  // Check if the message has a marker (i.e., it came from Server B)
  const originalMsg = removeMarker(msg);
  if (originalMsg) {
    // Forward to Client A
    if (CLIENT_A_IP && CLIENT_A_PORT) {
      serverA.send(originalMsg, CLIENT_A_PORT, CLIENT_A_IP, (err) => {
        if (err) {
          console.error("[serverA] Failed to send to Client A:", err);
        } else {
          console.log(`[serverA] Forwarded packet to Client A at ${CLIENT_A_IP}:${CLIENT_A_PORT}`);
        }
      });
    } else {
      console.log("[serverA] No Client A connected to forward the message.");
    }
  } else {
    // Message is from a client; forward to Server B
    CLIENT_A_IP = rinfo.address;
    CLIENT_A_PORT = rinfo.port;

    serverA.send(addMarker(msg), SERVER_PORT_B, "localhost", (err) => {
      if (err) {
        console.error("[serverA] Failed to send to Server B:", err);
      } else {
        console.log(`[serverA] Forwarded packet to Server B on port ${SERVER_PORT_B}`);
      }
    });
  }
});

// Handle incoming RTP packets on Server B
serverB.on("message", (msg, rinfo) => {
  console.log(`[serverB] Received packet from ${rinfo.address}:${rinfo.port}`);

  // Check if the message has a marker (i.e., it came from Server A)
  const originalMsg = removeMarker(msg);
  if (originalMsg) {
    // Forward to Client B
    if (CLIENT_B_IP && CLIENT_B_PORT) {
      serverB.send(originalMsg, CLIENT_B_PORT, CLIENT_B_IP, (err) => {
        if (err) {
          console.error("[serverB] Failed to send to Client B:", err);
        } else {
          console.log(`[serverB] Forwarded packet to Client B at ${CLIENT_B_IP}:${CLIENT_B_PORT}`);
        }
      });
    } else {
      console.log("[serverB] No Client B connected to forward the message.");
    }
  } else {
    // Message is from a client; forward to Server A
    CLIENT_B_IP = rinfo.address;
    CLIENT_B_PORT = rinfo.port;

    serverB.send(addMarker(msg), SERVER_PORT_A, "localhost", (err) => {
      if (err) {
        console.error("[serverB] Failed to send to Server A:", err);
      } else {
        console.log(`[serverB] Forwarded packet to Server A on port ${SERVER_PORT_A}`);
      }
    });
  }
});

// Start Server A
serverA.bind(SERVER_PORT_A, () => {
  console.log(`Server A listening on port ${SERVER_PORT_A}`);
});

// Start Server B
serverB.bind(SERVER_PORT_B, () => {
  console.log(`Server B listening on port ${SERVER_PORT_B}`);
});
