const dgram = require('dgram');
const mic = require('mic');
const { contextBridge } = require('electron');

const UDP_SERVER_IP = '127.0.0.1';
const UDP_SERVER_PORT = 4000;

// Create a UDP socket
const socket = dgram.createSocket('udp4');

// Capture audio using the microphone
function startAudioTransmission() {
  const micInstance = mic({
    rate: '48000',
    channels: '1',
    debug: false,
    encoding: 'linear16'
  });

  const micInputStream = micInstance.getAudioStream();

  micInputStream.on('data', (data) => {
    socket.send(data, UDP_SERVER_PORT, UDP_SERVER_IP, (err) => {
      if (err) console.error('UDP send error:', err);
      else console.log('Audio packet sent via UDP');
    });
  });

  micInstance.start();
  console.log('Audio capture started');
}

// Expose function to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  startTransmission: startAudioTransmission
});
