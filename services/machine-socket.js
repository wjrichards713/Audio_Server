const dgram = require("dgram");

let machineSocket;

function initializeMachineSocket() {
  machineSocket = dgram.createSocket("udp4");
  
  machineSocket.bind(3002, () => {
    const {port} = machineSocket.address();
    console.log('Socket bound to port '+port);
    
    machineSocket.on('error', (err) => {
      console.error('Socket error:', err);
    });
    
    machineSocket.on("message", (data, rinfo) => {
      try {
        const {packet, port} = JSON.parse(data.toString('utf-8'));
        const { members } = require('./websocket');
        const { udpSockets, udpClients } = require('./udp');
        
        if (packet.channel_id && members[packet.channel_id]) {
          console.log(packet, port, members[packet.channel_id]);
          console.log("🚀 ~ mebers[packet.channel_id].forEmach ~   members[packet.channel_id]:",   members[packet.channel_id])

          members[packet.channel_id].forEach((p) => {
            console.log("🚀 ~ machineSocket.on ~ packet, port:", p ,packet, port)

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
      } catch ($e) { }
    });
  });
  
  return machineSocket;
}

module.exports = {
  initializeMachineSocket,
  get machineSocket() { return machineSocket; }
};