// using System;
// using System.Collections.Concurrent;
// using System.Collections.Generic;
// using System.IO;
// using System.Linq;
// using System.Net;
// using System.Net.Sockets;
// using System.Security.Cryptography;
// using System.Text;
// using System.Text.Json;
// using System.Threading.Tasks;
// using Microsoft.AspNetCore.Builder;
// using Microsoft.AspNetCore.Hosting;
// using Microsoft.AspNetCore.Http;
// using Microsoft.AspNetCore.Mvc;
// using Microsoft.AspNetCore.Server.Kestrel.Core;
// using Microsoft.Extensions.DependencyInjection;
// using Microsoft.Extensions.FileProviders;
// using Microsoft.Extensions.Hosting;
// using System.Net.WebSockets;

// namespace AudioServer
// {
//     public class Startup
//     {
//         public void ConfigureServices(IServiceCollection services)
//         {
//             services.AddCors();
//             services.AddControllers();
//         }

//         public void Configure(IApplicationBuilder app, IWebHostEnvironment env)
//         {
//             if (env.IsDevelopment())
//             {
//                 app.UseDeveloperExceptionPage();
//             }

//             app.UseRouting();
//             app.UseCors(builder => builder.AllowAnyOrigin().AllowAnyMethod().AllowAnyHeader());
//             app.UseDefaultFiles(new DefaultFilesOptions
//                 {
//                     FileProvider = new PhysicalFileProvider(Path.Combine(Directory.GetCurrentDirectory(), "client"))
//                 });

//                 // Serve static files from the "client" folder from the root URL
//                 app.UseStaticFiles(new StaticFileOptions
//                 {
//                     FileProvider = new PhysicalFileProvider(Path.Combine(Directory.GetCurrentDirectory(), "client"))
//                 });
//             app.UseWebSockets();
//             app.UseEndpoints(endpoints =>
//             {
//                 endpoints.MapControllers();
//             });

//             app.Use(async (context, next) =>
// {
//     if (context.Request.Path.StartsWithSegments("/ws") && context.WebSockets.IsWebSocketRequest)
//     {
//         using var webSocket = await context.WebSockets.AcceptWebSocketAsync();
//         await WebSocketHandler.HandleWebSocket(context, webSocket);
//     }
//     else
//     {
//         await next();
//     }
// });

//         }
//     }

//     [ApiController]

//     public class AudioServerController : ControllerBase
//     {
//         private static readonly ConcurrentDictionary<int, UdpClient> udpSockets = new();
//         private static readonly ConcurrentDictionary<int, IPEndPoint> udpClients = new();
//         public static readonly ConcurrentDictionary<string, List<int>> members = new();
//         private static readonly ConcurrentDictionary<int, Dictionary<string, object>> users = new();

//         [HttpGet("/audio-server-port")]
//         public async Task<IActionResult> GetAvailablePort()
//         {
//             var (socket, port) = await CreateUdpSocket();
//             socket.Close();
//             udpSockets.TryRemove(port, out _);

//             return Ok(new
//             {
//                 udp_port = port,
//                 websocket_id = port,
//                 aes_key = "eyJhbGciOiJIUzI1eyJhbGciOiJIUzI1eyJhbGciOiJIUzI1"
//             });
//         }

//         [HttpGet("audio-server-connected-users")]
//         public IActionResult GetConnectedUsers()
//         {
//             return Ok(new { udpSockets, members, udpClients, users });
//         }

//         public static async Task<(UdpClient, int)> CreateUdpSocket(int port = 0)
//         {
//             var udp = new UdpClient(port);
//             var localEndPoint = (IPEndPoint)udp.Client.LocalEndPoint;
//             udpSockets[localEndPoint.Port] = udp;

//             Console.WriteLine($"UDP Socket listening on port {localEndPoint.Port}");
//             _ = Task.Run(() => ReceiveUdpMessages(udp, localEndPoint.Port));

//             return (udp, localEndPoint.Port);
//         }

//         private static async Task ReceiveUdpMessages(UdpClient udp, int port)
//         {
//             while (true)
//             {
//                 try
//                 {
//                     var result = await udp.ReceiveAsync();
//                     var message = Encoding.UTF8.GetString(result.Buffer);
//                     Console.WriteLine($"Received: {message}");
//                     udpClients[port] = result.RemoteEndPoint;

//                     if (JsonSerializer.Deserialize<Dictionary<string, object>>(message) is { } packet && packet.ContainsKey("channel_id"))
//                     {
//                         string channelId = packet["channel_id"].ToString();
//                         if (members.ContainsKey(channelId))
//                         {
//                             foreach (var p in members[channelId])
//                             {
//                                 if (p != port && udpSockets.TryGetValue(p, out var client) && udpClients.TryGetValue(p, out var remote))
//                                 {
//                                     await client.SendAsync(result.Buffer, result.Buffer.Length, remote);
//                                 }
//                             }
//                         }
//                     }
//                 }
//                 catch (Exception ex)
//                 {
//                     Console.WriteLine($"UDP Error: {ex.Message}");
//                 }
//             }
//         }
//     }

//     public class WebSocketHandler
// {
//     public static async Task HandleWebSocket(HttpContext context, WebSocket webSocket)
//     {
//         try
//         {
//             string websocketId = context.Request.Query["websocket_id"];
//             if (!int.TryParse(websocketId, out int wsId))
//             {
//                 await webSocket.CloseAsync(WebSocketCloseStatus.InvalidMessageType, "Invalid websocket ID", CancellationToken.None);
//                 return;
//             }

//             Console.WriteLine($"WebSocket Connected: {wsId}");

//             // Ensure UDP socket exists for this WebSocket
//             await AudioServerController.CreateUdpSocket(wsId);

//             var buffer = new byte[1024 * 4];

//             while (webSocket.State == WebSocketState.Open)
//             {
//                 var result = await webSocket.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
//                 if (result.MessageType == WebSocketMessageType.Close)
//                 {
//                     Console.WriteLine($"WebSocket Disconnected: {wsId}");
//                     await webSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closing", CancellationToken.None);
//                     return;
//                 }

//                 string message = Encoding.UTF8.GetString(buffer, 0, result.Count);
//                 Console.WriteLine($"WebSocket Received: {message}");

//                 if (JsonSerializer.Deserialize<Dictionary<string, object>>(message) is { } msgData)
//                 {
//                     if (msgData.ContainsKey("connect"))
//                     {
//                         string channelId = msgData["connect"].ToString();
//                         if (!AudioServerController.members.ContainsKey(channelId))
//                             AudioServerController.members[channelId] = new List<int>();

//                         AudioServerController.members[channelId].Add(wsId);
//                     }
//                 }
//             }
//         }
//         catch (Exception ex)
//         {
//             Console.WriteLine($"WebSocket Error: {ex.Message}");
//         }
//     }
// }


//     public class Program
//     {
//         public static void Main(string[] args)
//         {
//             Host.CreateDefaultBuilder(args)
//                 .ConfigureWebHostDefaults(webBuilder =>
//                 {
//                     webBuilder.ConfigureServices(services =>
//                     {
//                         services.Configure<KestrelServerOptions>(options =>
//                         {
//                             options.Listen(IPAddress.Any, 3000);
//                             options.Listen(IPAddress.Any, 3001);
//                         });
//                     });
//                     webBuilder.UseStartup<Startup>();
//                 })
//                 .Build()
//                 .Run();
//         }
//     }
// }



using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using System.Net.WebSockets;
using Concentus.Structs;
using Concentus.Enums;

namespace AudioServer
{
    // =====================================================
    // Barix device registration model
    // =====================================================
    public class BarixDevice
    {
        public string DeviceId { get; set; }
        public string Name { get; set; }
        public string ChannelId { get; set; }
        public int UdpPort { get; set; }
        public string SourceAddress { get; set; }
        public DateTime RegisteredAt { get; set; }
        public DateTime LastAudioReceived { get; set; }
        public bool IsActive { get; set; }
        public long PacketsReceived { get; set; }
        public long FramesEncoded { get; set; }
        public long BytesReceived { get; set; }
    }

    // =====================================================
    // Barix configuration model (maps to appsettings.json "Barix" section)
    // =====================================================
    public class BarixConfig
    {
        public int PortRangeStart { get; set; } = 6000;
        public int PortRangeEnd { get; set; } = 6099;
        public int SampleRate { get; set; } = 48000;
        public int Channels { get; set; } = 1;
        public int BitDepth { get; set; } = 16;
        public int OpusBitrate { get; set; } = 64000;
        public int FrameDurationMs { get; set; } = 20;
        public bool VoxEnabled { get; set; } = true;
        public int VoxThresholdRms { get; set; } = 200;
        public int VoxHoldTimeMs { get; set; } = 500;
    }

    // =====================================================
    // BarixIngestionService: Receives raw PCM UDP from Barix InStreamer devices,
    // encodes to Opus, encrypts with AES-GCM, wraps in JSON, and forwards
    // to channel members using the existing forwarding infrastructure.
    // =====================================================
    public class BarixIngestionService
    {
        private static readonly ConcurrentDictionary<string, BarixDevice> _devices = new();
        private static readonly ConcurrentDictionary<string, UdpClient> _listeners = new();
        private static readonly ConcurrentDictionary<string, CancellationTokenSource> _cancellationTokens = new();

        private static BarixConfig _config = new();
        private static readonly string AES_KEY = "eyJhbGciOiJIUzI1eyJhbGciOiJIUzI1eyJhbGciOiJIUzI1";

        public static void Initialize(IConfiguration configuration)
        {
            var section = configuration.GetSection("Barix");
            if (section.Exists())
            {
                _config = section.Get<BarixConfig>() ?? new BarixConfig();
            }
            Console.WriteLine($"[Barix] Initialized - Port range: {_config.PortRangeStart}-{_config.PortRangeEnd}, " +
                              $"Sample rate: {_config.SampleRate}Hz, Channels: {_config.Channels}, " +
                              $"Opus bitrate: {_config.OpusBitrate}bps, Frame: {_config.FrameDurationMs}ms, " +
                              $"VOX: {(_config.VoxEnabled ? $"enabled (threshold={_config.VoxThresholdRms}, hold={_config.VoxHoldTimeMs}ms)" : "disabled")}");
        }

        public static BarixConfig GetConfig() => _config;

        public static ConcurrentDictionary<string, BarixDevice> GetDevices() => _devices;

        // Register a new Barix device and start listening for its audio
        public static BarixDevice RegisterDevice(string deviceId, string name, string channelId, int? requestedPort = null)
        {
            if (_devices.ContainsKey(deviceId))
            {
                throw new InvalidOperationException($"Device '{deviceId}' is already registered.");
            }

            // Allocate a port from the Barix range
            int port = requestedPort ?? AllocatePort();

            var device = new BarixDevice
            {
                DeviceId = deviceId,
                Name = name,
                ChannelId = channelId,
                UdpPort = port,
                RegisteredAt = DateTime.UtcNow,
                IsActive = false,
                PacketsReceived = 0,
                FramesEncoded = 0,
                BytesReceived = 0
            };

            if (!_devices.TryAdd(deviceId, device))
            {
                throw new InvalidOperationException($"Failed to register device '{deviceId}'.");
            }

            // Start the UDP listener for this device
            StartListener(device);

            Console.WriteLine($"[Barix] Registered device '{name}' (ID: {deviceId}) on port {port} -> channel {channelId}");
            return device;
        }

        // Remove a Barix device and stop its listener
        public static bool RemoveDevice(string deviceId)
        {
            if (!_devices.TryRemove(deviceId, out var device))
            {
                return false;
            }

            StopListener(deviceId);

            // Remove the Barix virtual member from the channel
            if (AudioServerController.members.TryGetValue(device.ChannelId, out var memberList))
            {
                memberList.Remove(device.UdpPort);
            }

            Console.WriteLine($"[Barix] Removed device '{device.Name}' (ID: {deviceId}) from port {device.UdpPort}");
            return true;
        }

        // Allocate the next available port in the configured range
        private static int AllocatePort()
        {
            var usedPorts = _devices.Values.Select(d => d.UdpPort).ToHashSet();
            for (int p = _config.PortRangeStart; p <= _config.PortRangeEnd; p++)
            {
                if (!usedPorts.Contains(p))
                {
                    return p;
                }
            }
            throw new InvalidOperationException($"No available ports in range {_config.PortRangeStart}-{_config.PortRangeEnd}.");
        }

        // Start a UDP listener for a specific Barix device
        private static void StartListener(BarixDevice device)
        {
            var cts = new CancellationTokenSource();
            _cancellationTokens[device.DeviceId] = cts;

            var udp = new UdpClient(device.UdpPort);
            _listeners[device.DeviceId] = udp;

            Console.WriteLine($"[Barix] UDP listener started on port {device.UdpPort} for device '{device.Name}'");

            _ = Task.Run(() => ReceiveBarixAudio(udp, device, cts.Token));
        }

        // Stop the UDP listener for a specific device
        private static void StopListener(string deviceId)
        {
            if (_cancellationTokens.TryRemove(deviceId, out var cts))
            {
                cts.Cancel();
                cts.Dispose();
            }
            if (_listeners.TryRemove(deviceId, out var udp))
            {
                try { udp.Close(); } catch { }
            }
        }

        // Core audio receive loop: receives raw PCM from Barix, accumulates into frames,
        // encodes to Opus, encrypts, wraps in JSON, and forwards to channel members.
        private static async Task ReceiveBarixAudio(UdpClient udp, BarixDevice device, CancellationToken ct)
        {
            // 20ms frame at 48kHz mono = 960 samples = 1920 bytes (16-bit PCM)
            int samplesPerFrame = _config.SampleRate * _config.FrameDurationMs / 1000;
            int bytesPerFrame = samplesPerFrame * (_config.BitDepth / 8) * _config.Channels;

            // PCM accumulation buffer
            byte[] pcmAccumulator = new byte[bytesPerFrame * 4]; // extra room for partial packets
            int accumulatorOffset = 0;

            // Opus encoder setup
            var encoder = new OpusEncoder(_config.SampleRate, _config.Channels, OpusApplication.OPUS_APPLICATION_VOIP);
            encoder.Bitrate = _config.OpusBitrate;
            encoder.Complexity = 5;
            encoder.SignalType = OpusSignal.OPUS_SIGNAL_VOICE;

            byte[] opusOutput = new byte[4000]; // max Opus frame output buffer
            byte[] aesKeyBytes = Encoding.UTF8.GetBytes(AES_KEY);
            // AES-GCM requires 16, 24, or 32 byte key - take first 32 bytes
            byte[] aesKey = new byte[32];
            Array.Copy(aesKeyBytes, 0, aesKey, 0, Math.Min(aesKeyBytes.Length, 32));

            // VOX state
            bool voxActive = false;
            DateTime lastVoiceDetected = DateTime.MinValue;

            Console.WriteLine($"[Barix] Audio pipeline ready for device '{device.Name}': " +
                              $"{samplesPerFrame} samples/frame, {bytesPerFrame} bytes/frame");

            while (!ct.IsCancellationRequested)
            {
                try
                {
                    var result = await udp.ReceiveAsync();

                    // Track the source address on first packet
                    if (device.SourceAddress == null)
                    {
                        device.SourceAddress = result.RemoteEndPoint.Address.ToString();
                        Console.WriteLine($"[Barix] Device '{device.Name}' source address: {device.SourceAddress}");
                    }

                    device.IsActive = true;
                    device.LastAudioReceived = DateTime.UtcNow;
                    device.PacketsReceived++;
                    device.BytesReceived += result.Buffer.Length;

                    // Copy received PCM bytes into the accumulator
                    int bytesToCopy = Math.Min(result.Buffer.Length, pcmAccumulator.Length - accumulatorOffset);
                    Array.Copy(result.Buffer, 0, pcmAccumulator, accumulatorOffset, bytesToCopy);
                    accumulatorOffset += bytesToCopy;

                    // Process complete frames from the accumulator
                    while (accumulatorOffset >= bytesPerFrame)
                    {
                        // Extract one frame of PCM data
                        short[] pcmFrame = new short[samplesPerFrame];
                        for (int i = 0; i < samplesPerFrame; i++)
                        {
                            // Little-endian 16-bit PCM
                            pcmFrame[i] = (short)(pcmAccumulator[i * 2] | (pcmAccumulator[i * 2 + 1] << 8));
                        }

                        // Shift remaining data in the accumulator
                        int remaining = accumulatorOffset - bytesPerFrame;
                        if (remaining > 0)
                        {
                            Array.Copy(pcmAccumulator, bytesPerFrame, pcmAccumulator, 0, remaining);
                        }
                        accumulatorOffset = remaining;

                        // VOX detection: compute RMS of the frame
                        if (_config.VoxEnabled)
                        {
                            double sumSquares = 0;
                            for (int i = 0; i < pcmFrame.Length; i++)
                            {
                                sumSquares += (double)pcmFrame[i] * pcmFrame[i];
                            }
                            double rms = Math.Sqrt(sumSquares / pcmFrame.Length);

                            if (rms >= _config.VoxThresholdRms)
                            {
                                lastVoiceDetected = DateTime.UtcNow;
                                if (!voxActive)
                                {
                                    voxActive = true;
                                    Console.WriteLine($"[Barix] VOX activated for device '{device.Name}' (RMS: {rms:F0})");
                                }
                            }
                            else if (voxActive && (DateTime.UtcNow - lastVoiceDetected).TotalMilliseconds > _config.VoxHoldTimeMs)
                            {
                                voxActive = false;
                                Console.WriteLine($"[Barix] VOX deactivated for device '{device.Name}' (RMS: {rms:F0})");
                            }

                            // Skip encoding and forwarding if VOX says silence
                            if (!voxActive) continue;
                        }

                        // Opus encode the PCM frame
                        int encodedLength;
                        try
                        {
                            encodedLength = encoder.Encode(pcmFrame, 0, samplesPerFrame, opusOutput, 0, opusOutput.Length);
                        }
                        catch (Exception ex)
                        {
                            Console.WriteLine($"[Barix] Opus encode error for device '{device.Name}': {ex.Message}");
                            continue;
                        }

                        if (encodedLength <= 0) continue;

                        byte[] opusFrame = new byte[encodedLength];
                        Array.Copy(opusOutput, 0, opusFrame, 0, encodedLength);
                        device.FramesEncoded++;

                        // AES-GCM encrypt the Opus frame
                        byte[] encryptedPacket;
                        try
                        {
                            encryptedPacket = EncryptAES(opusFrame, aesKey);
                        }
                        catch (Exception ex)
                        {
                            Console.WriteLine($"[Barix] AES encrypt error for device '{device.Name}': {ex.Message}");
                            continue;
                        }

                        // Base64 encode
                        string audioBase64 = Convert.ToBase64String(encryptedPacket);

                        // Build JSON packet matching the format expected by clients
                        string jsonPacket = JsonSerializer.Serialize(new
                        {
                            channel_id = device.ChannelId,
                            audio = audioBase64
                        });

                        byte[] packetBytes = Encoding.UTF8.GetBytes(jsonPacket);

                        // Forward to all channel members
                        if (AudioServerController.members.TryGetValue(device.ChannelId, out var memberList))
                        {
                            foreach (int memberPort in memberList)
                            {
                                // Don't send back to the Barix device's own port
                                if (memberPort == device.UdpPort) continue;

                                if (AudioServerController.udpSockets.TryGetValue(memberPort, out UdpClient targetSocket) &&
                                    AudioServerController.udpClients.TryGetValue(memberPort, out IPEndPoint remoteEndpoint))
                                {
                                    try
                                    {
                                        await targetSocket.SendAsync(packetBytes, packetBytes.Length, remoteEndpoint);
                                    }
                                    catch (ObjectDisposedException) { }
                                    catch (Exception ex)
                                    {
                                        Console.WriteLine($"[Barix] Error forwarding to member {memberPort}: {ex.Message}");
                                    }
                                }
                            }
                        }
                    }
                }
                catch (ObjectDisposedException)
                {
                    Console.WriteLine($"[Barix] Listener socket disposed for device '{device.Name}'");
                    break;
                }
                catch (SocketException ex) when (ct.IsCancellationRequested)
                {
                    Console.WriteLine($"[Barix] Listener stopped for device '{device.Name}': {ex.Message}");
                    break;
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"[Barix] Error in listener for device '{device.Name}': {ex.Message}");
                }
            }

            device.IsActive = false;
            Console.WriteLine($"[Barix] Listener exited for device '{device.Name}'");
        }

        // AES-GCM encrypt: produces IV (12 bytes) + ciphertext + auth tag (16 bytes)
        // This matches the format used by existing clients.
        private static byte[] EncryptAES(byte[] plaintext, byte[] key)
        {
            byte[] iv = new byte[12];
            RandomNumberGenerator.Fill(iv);

            byte[] ciphertext = new byte[plaintext.Length];
            byte[] authTag = new byte[16];

            using var aes = new AesGcm(key, 16);
            aes.Encrypt(iv, plaintext, ciphertext, authTag);

            // Combine: IV + ciphertext + authTag
            byte[] result = new byte[iv.Length + ciphertext.Length + authTag.Length];
            Array.Copy(iv, 0, result, 0, iv.Length);
            Array.Copy(ciphertext, 0, result, iv.Length, ciphertext.Length);
            Array.Copy(authTag, 0, result, iv.Length + ciphertext.Length, authTag.Length);
            return result;
        }
    }

    // =====================================================
    // Startup class: Sets up API endpoints, static files, and WebSocket middleware.
    // =====================================================
    public class Startup
    {
        private readonly IConfiguration _configuration;

        public Startup(IConfiguration configuration)
        {
            _configuration = configuration;
        }

        public void ConfigureServices(IServiceCollection services)
        {
            services.AddCors();
            services.AddControllers();
        }

        public void Configure(IApplicationBuilder app, IWebHostEnvironment env)
        {
            if (env.IsDevelopment())
            {
                app.UseDeveloperExceptionPage();
            }

            // Initialize the Barix ingestion service with configuration
            BarixIngestionService.Initialize(_configuration);

            app.UseRouting();
            app.UseCors(builder => builder.AllowAnyOrigin().AllowAnyMethod().AllowAnyHeader());

            // Serve files from the "client" folder.
            app.UseDefaultFiles(new DefaultFilesOptions
            {
                FileProvider = new PhysicalFileProvider(Path.Combine(Directory.GetCurrentDirectory(), "client"))
            });
            app.UseStaticFiles(new StaticFileOptions
            {
                FileProvider = new PhysicalFileProvider(Path.Combine(Directory.GetCurrentDirectory(), "client"))
            });

            app.UseWebSockets();
            app.UseEndpoints(endpoints =>
            {
                endpoints.MapControllers();
            });

            // Handle WebSocket requests on "/ws"
            app.Use(async (context, next) =>
            {
                if (context.Request.Path.StartsWithSegments("/ws") && context.WebSockets.IsWebSocketRequest)
                {
                    using var webSocket = await context.WebSockets.AcceptWebSocketAsync();
                    await WebSocketHandler.HandleWebSocket(context, webSocket);
                }
                else
                {
                    await next();
                }
            });
        }
    }

    // =====================================================
    // AudioServerController: API endpoints and UDP socket management.
    // =====================================================
    [ApiController]
    public class AudioServerController : ControllerBase
    {
        // Public dictionaries so that WebSocketHandler and BarixIngestionService can access them.
        public static readonly ConcurrentDictionary<int, UdpClient> udpSockets = new();
        public static readonly ConcurrentDictionary<int, IPEndPoint> udpClients = new();
        public static readonly ConcurrentDictionary<string, List<int>> members = new();
        public static readonly ConcurrentDictionary<int, Timer> udpTimeoutTimers = new();
        public static readonly ConcurrentDictionary<int, Dictionary<string, object>> users = new();

        // GET /audio-server-port
        // Creates a temporary UDP socket to determine an available port, then closes it.
        [HttpGet("/audio-server-port")]
        public async Task<IActionResult> GetAvailablePort()
        {
            var (socket, port) = await CreateUdpSocket();
            // Mimic Node.js behavior: close the temporary socket.
            socket.Close();
            udpSockets.TryRemove(port, out _);
            if (udpTimeoutTimers.TryRemove(port, out Timer timer))
            {
                timer.Dispose();
            }
            Console.WriteLine($"Returning available port {port} and closing temporary UDP socket.");
            return Ok(new
            {
                udp_port = port,
                websocket_id = port,
                aes_key = "eyJhbGciOiJIUzI1eyJhbGciOiJIUzI1eyJhbGciOiJIUzI1"
            });
        }

        // GET /audio-server-connected-users
        [HttpGet("audio-server-connected-users")]
        public IActionResult GetConnectedUsers()
        {
            return Ok(new { udpSockets, members, udpClients, users });
        }

        // =====================================================
        // Barix API Endpoints
        // =====================================================

        // POST /api/barix/register
        // Register a new Barix InStreamer device and bind it to a channel.
        [HttpPost("/api/barix/register")]
        public IActionResult RegisterBarixDevice([FromBody] JsonElement body)
        {
            try
            {
                string deviceId = body.GetProperty("device_id").GetString();
                string name = body.GetProperty("name").GetString();
                string channelId = body.GetProperty("channel_id").GetString();
                int? port = body.TryGetProperty("port", out var portEl) ? portEl.GetInt32() : null;

                var device = BarixIngestionService.RegisterDevice(deviceId, name, channelId, port);

                // Add the Barix device as a virtual member of the channel
                if (!members.ContainsKey(channelId))
                {
                    members[channelId] = new List<int>();
                }
                if (!members[channelId].Contains(device.UdpPort))
                {
                    members[channelId].Add(device.UdpPort);
                }

                return Ok(new
                {
                    status = "registered",
                    device_id = device.DeviceId,
                    name = device.Name,
                    channel_id = device.ChannelId,
                    udp_port = device.UdpPort,
                    message = $"Barix InStreamer registered. Configure the InStreamer to send raw PCM " +
                              $"(16-bit LE, {BarixIngestionService.GetConfig().SampleRate}Hz, " +
                              $"{BarixIngestionService.GetConfig().Channels}ch) via UDP to this server on port {device.UdpPort}."
                });
            }
            catch (Exception ex)
            {
                return BadRequest(new { error = ex.Message });
            }
        }

        // GET /api/barix/devices
        // List all registered Barix devices and their status.
        [HttpGet("/api/barix/devices")]
        public IActionResult GetBarixDevices()
        {
            var devices = BarixIngestionService.GetDevices().Values.Select(d => new
            {
                device_id = d.DeviceId,
                name = d.Name,
                channel_id = d.ChannelId,
                udp_port = d.UdpPort,
                source_address = d.SourceAddress,
                is_active = d.IsActive,
                last_audio = d.LastAudioReceived,
                packets_received = d.PacketsReceived,
                frames_encoded = d.FramesEncoded,
                bytes_received = d.BytesReceived,
                registered_at = d.RegisteredAt
            });

            return Ok(new { devices, config = BarixIngestionService.GetConfig() });
        }

        // GET /api/barix/devices/{id}/status
        // Get detailed status for a specific Barix device.
        [HttpGet("/api/barix/devices/{id}/status")]
        public IActionResult GetBarixDeviceStatus(string id)
        {
            if (!BarixIngestionService.GetDevices().TryGetValue(id, out var device))
            {
                return NotFound(new { error = $"Device '{id}' not found." });
            }

            return Ok(new
            {
                device_id = device.DeviceId,
                name = device.Name,
                channel_id = device.ChannelId,
                udp_port = device.UdpPort,
                source_address = device.SourceAddress,
                is_active = device.IsActive,
                last_audio = device.LastAudioReceived,
                packets_received = device.PacketsReceived,
                frames_encoded = device.FramesEncoded,
                bytes_received = device.BytesReceived,
                uptime_seconds = (DateTime.UtcNow - device.RegisteredAt).TotalSeconds,
                channel_members = members.TryGetValue(device.ChannelId, out var m) ? m.Count : 0
            });
        }

        // DELETE /api/barix/devices/{id}
        // Remove a Barix device registration and stop its listener.
        [HttpDelete("/api/barix/devices/{id}")]
        public IActionResult RemoveBarixDevice(string id)
        {
            if (BarixIngestionService.RemoveDevice(id))
            {
                return Ok(new { status = "removed", device_id = id });
            }
            return NotFound(new { error = $"Device '{id}' not found." });
        }

        // GET /api/barix/instreamer-config
        // Returns the recommended Barix InStreamer configuration settings.
        [HttpGet("/api/barix/instreamer-config")]
        public IActionResult GetInstreamerConfig()
        {
            var config = BarixIngestionService.GetConfig();
            return Ok(new
            {
                title = "Barix InStreamer Configuration Guide",
                network_settings = new
                {
                    protocol = "Raw UDP",
                    description = "Use 'Raw UDP' (not RTP) for lowest latency and simplest packet format.",
                    destination_ip = "<this_server_ip>",
                    destination_port = $"{config.PortRangeStart} (or the port returned when registering the device)"
                },
                audio_settings = new
                {
                    encoding = "PCM 16-bit (Linear)",
                    byte_order = "Little Endian",
                    sample_rate = $"{config.SampleRate} Hz",
                    channels = config.Channels == 1 ? "Mono" : "Stereo",
                    description = "Raw PCM is required. Do NOT enable MP3 or G.711 encoding on the InStreamer. " +
                                  "The server handles Opus encoding internally."
                },
                instreamer_web_ui_steps = new[]
                {
                    "1. Open the InStreamer web UI (default: http://<instreamer-ip>)",
                    "2. Go to Configuration > Audio",
                    $"3. Set 'Encoding' to 'PCM (Linear)' at {config.SampleRate} Hz",
                    "4. Set 'Channels' to 'Mono'",
                    "5. Set 'Bit Depth' to '16-bit'",
                    "6. Go to Configuration > Streaming",
                    "7. Set 'Protocol' to 'Raw UDP'",
                    "8. Set 'Destination IP' to this server's IP address",
                    $"9. Set 'Destination Port' to the assigned port (range: {config.PortRangeStart}-{config.PortRangeEnd})",
                    "10. Set 'Packet Size' to 960 bytes (recommended) or any multiple of frame size",
                    "11. Save and apply the configuration",
                    "12. The InStreamer will begin streaming immediately"
                },
                audio_input_setup = new[]
                {
                    "Connect the two-way radio's audio output (speaker/line out) to the InStreamer's RCA or 3.5mm input.",
                    "Adjust the radio output volume to avoid clipping (keep peaks below -3dB on the InStreamer level meter).",
                    "If the InStreamer has an input gain control, set it to a moderate level.",
                    "The server's VOX (Voice-Operated Switch) will detect silence and only forward audio when speech is detected."
                }
            });
        }

        // CreateUdpSocket: Creates (or re-creates) a UDP socket on a given port (or ephemeral port if port==0),
        // sets up a 30-second inactivity timer, and starts receiving UDP messages.
        public static async Task<(UdpClient, int)> CreateUdpSocket(int port = 0)
        {
            var udp = new UdpClient(port);
            var localEndPoint = (IPEndPoint)udp.Client.LocalEndPoint;
            int boundPort = localEndPoint.Port;
            udpSockets[boundPort] = udp;

            // Setup inactivity timer (30 seconds).
            Timer timer = new Timer(state =>
            {
                Console.WriteLine($"UDP Socket on port {boundPort} closed due to inactivity.");
                try
                {
                    udp.Close();
                    udpSockets.TryRemove(boundPort, out _);
                    udpClients.TryRemove(boundPort, out _);
                    if (udpTimeoutTimers.TryRemove(boundPort, out Timer removedTimer))
                    {
                        removedTimer.Dispose();
                    }
                }
                catch (ObjectDisposedException) { }
                catch (Exception ex)
                {
                    Console.WriteLine($"Error closing UDP socket on port {boundPort}: {ex.Message}");
                }
            }, null, TimeSpan.FromSeconds(30), Timeout.InfiniteTimeSpan);
            udpTimeoutTimers[boundPort] = timer;

            Console.WriteLine($"UDP Socket listening on port {boundPort}");
            // Start background task for receiving UDP messages.
            _ = Task.Run(() => ReceiveUdpMessages(udp, boundPort));
            return (udp, boundPort);
        }

        // ReceiveUdpMessages: Receives messages on the UDP socket, resets the inactivity timer,
        // registers the sender's remote endpoint, and forwards audio packets to other channel members.
        private static async Task ReceiveUdpMessages(UdpClient udp, int port)
        {
            while (true)
            {
                try
                {
                    var result = await udp.ReceiveAsync();
                    string message = Encoding.UTF8.GetString(result.Buffer);
                    Console.WriteLine($"[UDP] Received message on port {port}: {message}");

                    // Register sender's remote endpoint
                    udpClients[port] = result.RemoteEndPoint;

                    try
                    {
                        var packet = JsonSerializer.Deserialize<Dictionary<string, object>>(message);
                        if (packet != null)
                        {
                            string channelId = packet.ContainsKey("channel_id") ? packet["channel_id"].ToString()
                                            : packet.ContainsKey("channel") ? packet["channel"].ToString()
                                            : null;

                            if (!string.IsNullOrEmpty(channelId) && AudioServerController.members.ContainsKey(channelId))
                            {
                                Console.WriteLine($"[UDP] Channel {channelId} members: {string.Join(", ", AudioServerController.members[channelId])}");

                                foreach (var p in AudioServerController.members[channelId])
                                {
                                    if (p == port) continue; // Don't send to self

                                    if (udpSockets.TryGetValue(p, out UdpClient targetSocket) &&
                                        udpClients.TryGetValue(p, out IPEndPoint remoteEndpoint))
                                    {
                                        try
                                        {
                                            await targetSocket.SendAsync(result.Buffer, result.Buffer.Length, remoteEndpoint);
                                            Console.WriteLine($"[UDP] Forwarded from {port} to {remoteEndpoint.Address}:{remoteEndpoint.Port}");
                                        }
                                        catch (ObjectDisposedException)
                                        {
                                            Console.WriteLine($"[UDP] Failed to forward: Target UDP socket on port {p} is disposed.");
                                        }
                                        catch (Exception ex)
                                        {
                                            Console.WriteLine($"[UDP] Error forwarding to {remoteEndpoint.Address}:{remoteEndpoint.Port}: {ex.Message}");
                                        }
                                    }
                                    else
                                    {
                                        Console.WriteLine($"[UDP] Skipping member {p} - Missing UDP socket or endpoint.");
                                    }
                                }
                            }
                            else
                            {
                                Console.WriteLine($"[UDP] No valid channel_id found in the message or no members in channel {channelId}");
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine($"[UDP] Error parsing UDP message on port {port}: {ex.Message}");
                    }
                }
                catch (ObjectDisposedException)
                {
                    Console.WriteLine($"[UDP] Socket on port {port} has been disposed.");
                    break;
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"[UDP] Error on port {port}: {ex.Message}");
                    break;
                }
            }
        }

        // Optional: Helper function to decrypt AES data (if needed).
        public static byte[] DecryptAES(byte[] encryptedData, byte[] key)
        {
            byte[] iv = new byte[12];
            Array.Copy(encryptedData, 0, iv, 0, 12);
            byte[] authTag = new byte[16];
            Array.Copy(encryptedData, encryptedData.Length - 16, authTag, 0, 16);
            int payloadLength = encryptedData.Length - 12 - 16;
            byte[] encryptedPayload = new byte[payloadLength];
            Array.Copy(encryptedData, 12, encryptedPayload, 0, payloadLength);

            using var aes = new AesGcm(key, 16);
            byte[] decrypted = new byte[payloadLength];
            aes.Decrypt(iv, encryptedPayload, authTag, decrypted);
            return decrypted;
        }
    }

    // =====================================================
    // WebSocketHandler: Handles WebSocket connections and channel membership.
    // =====================================================
    public class WebSocketHandler
    {
        public static async Task HandleWebSocket(HttpContext context, WebSocket webSocket)
        {
            try
            {
                // Extract websocket_id from the query parameters
                string websocketIdStr = context.Request.Query["websocket_id"];
                if (!int.TryParse(websocketIdStr, out int wsId))
                {
                    await webSocket.CloseAsync(WebSocketCloseStatus.InvalidMessageType, "Invalid websocket ID", CancellationToken.None);
                    return;
                }

                Console.WriteLine($"[WebSocket] Connected: {wsId}");

                // Ensure UDP socket exists for this WebSocket connection
                if (!AudioServerController.udpSockets.ContainsKey(wsId))
                {
                    await AudioServerController.CreateUdpSocket(wsId);
                }

                var buffer = new byte[1024 * 4];
                while (webSocket.State == WebSocketState.Open)
                {
                    var result = await webSocket.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        Console.WriteLine($"[WebSocket] Disconnected: {wsId}");
                        await webSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closing", CancellationToken.None);
                        break;
                    }

                    string message = Encoding.UTF8.GetString(buffer, 0, result.Count);
                    Console.WriteLine($"[WebSocket] Received: {message}");

                    try
                    {
                        var msgData = JsonSerializer.Deserialize<Dictionary<string, object>>(message);
                        if (msgData != null)
                        {
                            if (msgData.ContainsKey("connect"))
                            {
                                // Handle connection message
                                var connectionData = JsonSerializer.Deserialize<Dictionary<string, object>>(msgData["connect"].ToString());
                                string channelId = connectionData.ContainsKey("channel_id") ? connectionData["channel_id"].ToString() : null;

                                if (!string.IsNullOrEmpty(channelId))
                                {
                                    if (!AudioServerController.members.ContainsKey(channelId))
                                    {
                                        AudioServerController.members[channelId] = new List<int>();
                                    }

                                    if (!AudioServerController.members[channelId].Contains(wsId))
                                    {
                                        AudioServerController.members[channelId].Add(wsId);
                                        Console.WriteLine($"[WebSocket] Client {wsId} joined channel {channelId}");
                                    }
                                }
                            }

                            if (msgData.ContainsKey("disconnect"))
                            {
                                // Handle disconnection message
                                var disconnectionData = JsonSerializer.Deserialize<Dictionary<string, object>>(msgData["disconnect"].ToString());
                                string channelId = disconnectionData.ContainsKey("channel_id") ? disconnectionData["channel_id"].ToString() : null;

                                if (!string.IsNullOrEmpty(channelId) && AudioServerController.members.ContainsKey(channelId))
                                {
                                    AudioServerController.members[channelId].Remove(wsId);
                                    Console.WriteLine($"[WebSocket] Client {wsId} left channel {channelId}");
                                }
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine($"[WebSocket] Error processing message: {ex.Message}");
                    }
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[WebSocket] Handler Error: {ex.Message}");
            }
        }
    }


    // =====================================================
    // Program entry point
    // =====================================================
    public class Program
    {
        public static void Main(string[] args)
        {
            Host.CreateDefaultBuilder(args)
                .ConfigureWebHostDefaults(webBuilder =>
                {
                    webBuilder.ConfigureServices(services =>
                    {
                        services.Configure<KestrelServerOptions>(options =>
                        {
                            // Listen on port 3000 for HTTP/API and 3001 for WebSocket.
                            options.Listen(IPAddress.Any, 3000);
                            options.Listen(IPAddress.Any, 3001);
                        });
                    });
                    webBuilder.UseStartup<Startup>();
                })
                .Build()
                .Run();
        }
    }
}
