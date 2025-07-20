const dgram = require("dgram");

function createSocket(p = 0, state) {
  const { udpSockets, udpClients, members, servers } = state;
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
      udpSockets[port] = socket;
      console.log(`UDP Socket listening on port ${port}`);
      socket.on("message", (msg, rinfo) => {
        console.log(`Received Packet from ${port}`);
        reinitTimeout();
        udpClients[port] = rinfo;
        try {
          const packet = JSON.parse(msg.toString('utf-8'));
          if (packet.channel_id && servers[packet.channel_id] && servers[packet.channel_id].length) {
            servers[packet.channel_id].forEach((server_address) => {
              if(server_address === `${state.serverPublicIP}:3002`) {
                members[packet.channel_id].forEach((p) => {
                  if(p != port && udpSockets[p] && udpClients[p]) {
                    udpSockets[p].send(JSON.stringify(packet), udpClients[p].port, udpClients[p].address, (err) => {
                      if (err) {
                        console.error(`Failed to send to ${udpClients[p].address}:${udpClients[p].port}`, err);
                      } else {
                        console.log(`Forwarded Packet to ${udpClients[p].address}:${udpClients[p].port}`);
                      }
                    });
                  }
                });
              } else {
                const [ip, p] = server_address.split(":");
                if (state.machineSocket) {
                  state.machineSocket.send(JSON.stringify({packet, port}), p, ip, (err) => {
                    if (err) {
                      console.error(`Failed to send to ${ip}:${p}`, err);
                    } else {
                      console.log(`Forwarded Packet to ${ip}:${p}`);
                    }
                  })
                }
              }
            });
          }
        } catch ($e) { console.log($e); }
      });
      socket.on("close", () => {
        console.log(`UDP Socket on port ${port} closed`);
        delete udpSockets[port];
        delete udpClients[port];
        clearTimeout(timeout);
      });
      reinitTimeout();
      resolve({socket, port});
    });
  });
}

function setupMachineSocket(state) {
  const { members, udpSockets, udpClients } = state;
  const machineSocket = dgram.createSocket("udp4");
  state.machineSocket = machineSocket;
  machineSocket.bind(3002, () => {
    const {port} = machineSocket.address();
    console.log(`Server Listening for InterConnected Servers on UDP ${port}`);
    machineSocket.on('error', console.error);
    machineSocket.on("message", (data, rinfo) => {
      try {
        const {packet, port} = JSON.parse(data.toString('utf-8'));
        if (packet.channel_id && members[packet.channel_id]) {
          members[packet.channel_id].forEach((p) => {
            if(p != port && udpSockets[p] && udpClients[p]) {
              udpSockets[p].send(JSON.stringify(packet), udpClients[p].port, udpClients[p].address, (err) => {
                if (err) {
                  console.error(`Failed to send to ${udpClients[p].address}:${udpClients[p].port}`, err);
                } else {
                  console.log(`Forwarded packet to ${udpClients[p].address}:${udpClients[p].port}`);
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
  return machineSocket;
}

module.exports = {
  createSocket,
  setupMachineSocket
};