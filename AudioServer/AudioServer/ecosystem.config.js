module.exports = {
  apps: [
    {
      name: "AudioServer",
      script: "dotnet",
      args: "run",
      cwd: "/home/ubuntu/Audio_Server/AudioServer/AudioServer",
      interpreter: "none",
      env: {
        ASPNETCORE_URLS: "http://0.0.0.0:3000", // Ensure it runs on all interfaces
        DOTNET_ENVIRONMENT: "Production"
      }
    }
  ]
};

