const { app, BrowserWindow } = require('electron');
const express = require('express');
const path = require('path');

let win;
const PORT = 3000;

app.whenReady().then(() => {
  // Start Express server to serve the HTML file
  const server = express();
  server.use(express.static(path.join(__dirname)));

  server.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'client.html'));
  });

  server.listen(PORT, () => {
    console.log(`HTTP server running at http://localhost:${PORT}`);
  });

  // Create Electron window
  win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true  // Enable Node.js in renderer process
    }
  });

  win.loadURL(`http://localhost:${PORT}`);

  win.on('closed', () => {
    win = null;
    server.close();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
