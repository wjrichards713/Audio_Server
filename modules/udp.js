const dgram = require("dgram");

function createSocket(p = 0) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.bind(p, () => {
      const {port} = (socket.address());
      p = port;
      let timeout = null;
      function reinitTimeout() {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          try {
            socket.close();
          } catch ($e) {
            console.error($e);
          }
        }, 30000);
      }
      global.udpSockets[port] = socket;
      console.log(`UDP Socket listening on port ${port}`);
      socket.on("message", (msg, rinfo) => {
        console.log("msg: ", msg, "rinfo", rinfo);
        
        reinitTimeout();
        global.udpClients[port] = rinfo;
        try {
          const packet = JSON.parse(msg.toString('utf-8'));
          if (packet.channel_id && global.servers[packet.channel_id] && global.servers[packet.channel_id].length) {
            const channels = global.patches[packet.channel_id] || [packet.channel_id];
            channels.forEach((channel) => {
              packet.channel_id = channel;
              (global.servers[packet.channel_id] || []).forEach((server_address) => {
                if(server_address === `${global.serverPublicIP}:3002`) {
                  global.members[packet.channel_id].forEach((p) => {
                    if(p != port && global.udpSockets[p] && global.udpClients[p]) {
                      global.udpSockets[p].send(JSON.stringify(packet), global.udpClients[p].port, global.udpClients[p].address, (err) => {
                        if (err) {
                          console.error(`Failed to send to ${global.udpClients[p].address}:${global.udpClients[p].port}`, err);
                        }
                      });
                    }
                  });
                } else {
                  const [ip, p] = server_address.split(":");
                  global.machineSocket.send(JSON.stringify({packet, port}), p, ip, (err) => {
                    if (err) {
                      console.error(`Failed to send to ${ip}:${p}`, err);
                    }
                  })
                }
              });
            })
          }
        } catch ($e) { console.log($e); }
      });
      socket.on("close", () => {
        console.log(`UDP Socket on port ${port} closed`);
        delete global.udpSockets[port];
        delete global.udpClients[port];
        clearTimeout(timeout);
      });
      reinitTimeout();
      resolve({socket, port});
    });
  });
}

function setupUDP(redis, publisher, subscriber) {
  const machineSocket = dgram.createSocket("udp4");
  global.machineSocket = machineSocket;

  machineSocket.bind(3002, () => {
    const {port} = machineSocket.address();
    console.log(`Server Listening for InterConnected Servers on UDP ${port}`);
    machineSocket.on('error', console.error);
    machineSocket.on("message", (data, rinfo) => {
      try {
        const {packet, port} = JSON.parse(data.toString('utf-8'));
        if (packet.channel_id && global.members[packet.channel_id]) {
          global.members[packet.channel_id].forEach((p) => {
            if(global.udpSockets[p] && global.udpClients[p]) {
              global.udpSockets[p].send(JSON.stringify(packet), global.udpClients[p].port, global.udpClients[p].address, (err) => {
                if (err) {
                  console.error(`Failed to send to ${global.udpClients[p].address}:${global.udpClients[p].port}`, err);
                }
              });
            }
          });
        }
      } catch ($e) {
        console.log($e);
      }
    });
  });
}

module.exports = { createSocket, setupUDP };