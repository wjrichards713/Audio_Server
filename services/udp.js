const dgram = require("dgram");

const udpSockets = {};
const udpClients = {};

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
            console.log($e);
          }
        }, 30000);
      }
      
      udpSockets[port] = socket;
      console.log("🚀 ~ socket.bind ~ udpSockets:", udpSockets)
      console.log(`UDP Socket listening on port ${port}`);
      
      socket.on("message", (msg, rinfo) => {
        console.log(rinfo, msg.toString('utf-8'));
        reinitTimeout();
        udpClients[port] = rinfo;
        
        try {
          const packet = JSON.parse(msg.toString('utf-8'));
          if (packet.channel_id) {
            const { patchedGroups } = require('./patching');
            const { servers } = require('./websocket');
            
            let targetChannels = [packet.channel_id];

            for (const group of patchedGroups) {
              if (group.includes(packet.channel_id)) {
                targetChannels = group;
                break;
              }
            }
            console.log("🚀 ~ socket.on ~ patchedGroups:", patchedGroups)
            console.log("🚀 ~ socket.on ~ targetChannels:", targetChannels)

            for (const ch of targetChannels) {
              if (servers[ch]) {
                servers[ch].forEach((server_address) => {
                  console.log("🚀 ~ servers[ch].forEach ~ server_address:", server_address)

                  if(server_address == process.env.AUDIOSERVER_ADDR) {
                    const { members } = require('./websocket');
                    members[ch].forEach((p) => {
                      if(udpSockets[p]) {
                        udpSockets[p].send(JSON.stringify(packet), udpClients[p].port, udpClients[p].address, (err) => {
                          if (err) {
                            console.error(`Failed to send to ${udpClients[p].address}:${udpClients[p].port}`, err);
                          } else {
                            console.log(`Forwarded packet to ${udpClients[p].address}:${udpClients[p].port}`);
                          }
                        });
                      }
                    });
                  } else {
                    const [ip, p] = server_address.split(":");
                    console.log("🚀 ~ members[packet.channel_id].forEach ~ ip, p:", ip, p)
                    packet.channel_id = ch;
                    
                    const { machineSocket } = require('./machine-socket');
                    machineSocket.send(JSON.stringify({packet, port}), p, ip, (err) => {
                      if (err) {
                        console.error(`Failed to send to ${ip}:${p}`, err);
                      } else {
                        console.log(`Forwarded packet to ${ip}:${p}`);
                      }
                    });
                  }
                });
              }
            }
          }
        } catch ($e) {}
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

module.exports = {
  createSocket,
  udpSockets,
  udpClients
};