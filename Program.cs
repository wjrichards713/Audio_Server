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
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using System.Net.WebSockets;

namespace AudioServer
{
    // =====================================================
    // Startup class: Sets up API endpoints, static files, and WebSocket middleware.
    // =====================================================
    public class Startup
    {
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
        // Public dictionaries so that WebSocketHandler can access them.
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

            using var aes = new AesGcm(key);
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
