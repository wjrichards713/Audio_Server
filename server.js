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
        console.log(data.data);
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
    } catch ($e) {}
  });
  server.bind(port, () => {
    console.log(`Server listening on port ${port}`);
  });
});