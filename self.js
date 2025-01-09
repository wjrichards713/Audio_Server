const dgram = require("dgram");

// Server Configuration
const SERVER_PORT = 8000; // Port to receive RTP packets
const CLIENT_PORT = 9000; // Port for clients to connect and receive RTP

// Create UDP socket
const server = dgram.createSocket("udp4");

// Handle incoming RTP packets
server.on("message", (msg, rinfo) => {
  console.log(`Received RTP packet from ${rinfo.address}:${rinfo.port}`);
  // const str = msg.toString('utf8');
  // console.log(JSON.parse(str))
  // const buff = Buffer.from(str.replace("\n", ''), 'utf-8');

  const str = msg.toString('utf8').replace(/\n/g, '');
  console.log(JSON.parse(str))
  const buff = Buffer.from(str, 'utf-8');

  // Broadcast RTP packets to all clients
  // server.setBroadcast(true); // Enable broadcasting
  server.send(buff, rinfo.port, rinfo.address, (err) => {
    if (err) {
      console.error("Failed to broadcast RTP packet:", err);
    } else {
      console.log(`Broadcasted RTP packet to port ${CLIENT_PORT}`);
    }
  });
});

// Start the server
server.bind(SERVER_PORT, () => {
  console.log(`RTP relay server listening on port ${SERVER_PORT}`);
});

