const dgram = require("dgram");

const available_ports = [8000, 8001];
const port_registrar = {}
const channel_ports = {
  '555': [8000, 8001],
  '666': [8001]
};

available_ports.forEach((port) => {
  const server = dgram.createSocket("udp4");
  server.on("message", (msg, rinfo) => {
    try {
      const data = JSON.parse(msg.toString('utf-8'));
      if (rinfo.address == '127.0.0.1' && port_registrar[port]) {
        console.log(data);
        server.send(msg, port_registrar[port].port, port_registrar[port].address, (err) => {
          if (err) {
            console.error(`Failed to send to ${port_registrar[port].address}:${port_registrar[port].port}`, err);
          } else {
            console.log(`Forwarded packet to ${port_registrar[port].address}:${port_registrar[port].port}`);
          }
        });
      } else if (rinfo.address != '127.0.0.1' && data.channel_id) {
        port_registrar[port] = rinfo;
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
        port_registrar[port] = rinfo;
      }
      console.log(port_registrar);
    } catch ($e) {}
  });
  server.bind(port, () => {
    console.log(`Server listening on port ${port}`);
  });
});


// serverA.on("message", (msg, rinfo) => {
//   console.log(`[serverA] Received packet from ${rinfo.address}:${rinfo.port}`);
  
//   if (originalMsg) {
//     // Forward to Client A
//     if (CLIENT_A_IP && CLIENT_A_PORT) {
//       serverA.send(originalMsg, CLIENT_A_PORT, CLIENT_A_IP, (err) => {
//         if (err) {
//           console.error("[serverA] Failed to send to Client A:", err);
//         } else {
//           console.log(`[serverA] Forwarded packet to Client A at ${CLIENT_A_IP}:${CLIENT_A_PORT}`);
//         }
//       });
//     } else {
//       console.log("[serverA] No Client A connected to forward the message.");
//     }
//   } else {
//     // Message is from a client; forward to Server B
//     CLIENT_A_IP = rinfo.address;
//     CLIENT_A_PORT = rinfo.port;

//     serverA.send(addMarker(msg), SERVER_PORT_B, "localhost", (err) => {
//       if (err) {
//         console.error("[serverA] Failed to send to Server B:", err);
//       } else {
//         console.log(`[serverA] Forwarded packet to Server B on port ${SERVER_PORT_B}`);
//       }
//     });
//   }
// });