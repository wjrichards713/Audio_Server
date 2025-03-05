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
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using System.Net.WebSockets;

namespace AudioServer
{
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
            
            // Serve default files from the "client" folder
            app.UseDefaultFiles(new DefaultFilesOptions
            {
                FileProvider = new PhysicalFileProvider(Path.Combine(Directory.GetCurrentDirectory(), "client"))
            });

            // Serve static files from the "client" folder
            app.UseStaticFiles(new StaticFileOptions
            {
                FileProvider = new PhysicalFileProvider(Path.Combine(Directory.GetCurrentDirectory(), "client"))
            });

            app.UseWebSockets();
            app.UseEndpoints(endpoints =>
            {
                endpoints.MapControllers();
            });

            // WebSocket handling
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

    [ApiController]
    public class AudioServerController : ControllerBase
    {
        public static readonly ConcurrentDictionary<int, UdpClient> udpSockets = new();
        private static readonly ConcurrentDictionary<int, IPEndPoint> udpClients = new();
        public static readonly ConcurrentDictionary<string, List<int>> members = new();
        private static readonly ConcurrentDictionary<int, Dictionary<string, object>> users = new();

        [HttpGet("/audio-server-port")]
        public async Task<IActionResult> GetAvailablePort()
        {
            // Create a new UDP socket to determine an available port
            var (socket, port) = await CreateUdpSocket();

            // ------------------------------
            // FIX: Remove the lines that close and remove the socket. 
            //     We want to keep the socket alive so that the background 
            //     ReceiveUdpMessages() task can continue to use it without errors.
            //
            // socket.Close();
            // udpSockets.TryRemove(port, out _);
            // ------------------------------

            return Ok(new
            {
                udp_port = port,
                websocket_id = port,
                aes_key = "eyJhbGciOiJIUzI1eyJhbGciOiJIUzI1eyJhbGciOiJIUzI1"
            });
        }

        [HttpGet("audio-server-connected-users")]
        public IActionResult GetConnectedUsers()
        {
            return Ok(new { udpSockets, members, udpClients, users });
        }

        public static async Task<(UdpClient, int)> CreateUdpSocket(int port = 0)
        {
            var udp = new UdpClient(port);
            var localEndPoint = (IPEndPoint)udp.Client.LocalEndPoint;
            udpSockets[localEndPoint.Port] = udp;

            Console.WriteLine($"UDP Socket listening on port {localEndPoint.Port}");

            // Start background listener for this socket
            _ = Task.Run(() => ReceiveUdpMessages(udp, localEndPoint.Port));

            return (udp, localEndPoint.Port);
        }

        private static async Task ReceiveUdpMessages(UdpClient udp, int port)
        {
            while (true)
            {
                try
                {
                    var result = await udp.ReceiveAsync();
                    var message = Encoding.UTF8.GetString(result.Buffer);
                    Console.WriteLine($"Received: {message}");
                    udpClients[port] = result.RemoteEndPoint;

                    if (JsonSerializer.Deserialize<Dictionary<string, object>>(message) is { } packet 
                        && packet.ContainsKey("channel_id"))
                    {
                        string channelId = packet["channel_id"].ToString();
                        if (members.ContainsKey(channelId))
                        {
                            foreach (var p in members[channelId])
                            {
                                if (p != port 
                                    && udpSockets.TryGetValue(p, out var client) 
                                    && udpClients.TryGetValue(p, out var remote))
                                {
                                    await client.SendAsync(result.Buffer, result.Buffer.Length, remote);
                                }
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"UDP Error: {ex.Message}");
                }
            }
        }
    }

   public class WebSocketHandler
{
    public static async Task HandleWebSocket(HttpContext context, WebSocket webSocket)
    {
        try
        {
            string websocketId = context.Request.Query["websocket_id"];
            if (!int.TryParse(websocketId, out int wsId))
            {
                await webSocket.CloseAsync(
                    WebSocketCloseStatus.InvalidMessageType,
                    "Invalid websocket ID",
                    CancellationToken.None
                );
                return;
            }

            Console.WriteLine($"WebSocket Connected: {wsId}");

            // ---------------------------------------------
            // Only create a new UDP socket if we do NOT already have one
            if (!AudioServerController.udpSockets.ContainsKey(wsId))
            {
                await AudioServerController.CreateUdpSocket(wsId);
            }
            // ---------------------------------------------

            var buffer = new byte[1024 * 4];

            while (webSocket.State == WebSocketState.Open)
            {
                var result = await webSocket.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    Console.WriteLine($"WebSocket Disconnected: {wsId}");
                    
                    // Clean up the UDP socket so we can re-use this port later
                    if (AudioServerController.udpSockets.TryGetValue(wsId, out var client))
                    {
                        client.Close();
                        AudioServerController.udpSockets.TryRemove(wsId, out _);
                    }

                    await webSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closing", CancellationToken.None);
                    return;
                }

                string message = Encoding.UTF8.GetString(buffer, 0, result.Count);
                Console.WriteLine($"WebSocket Received: {message}");

                if (JsonSerializer.Deserialize<Dictionary<string, object>>(message) is { } msgData)
                {
                    if (msgData.ContainsKey("connect"))
                    {
                        string channelId = msgData["connect"].ToString();
                        if (!AudioServerController.members.ContainsKey(channelId))
                            AudioServerController.members[channelId] = new List<int>();

                        AudioServerController.members[channelId].Add(wsId);
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"WebSocket Error: {ex.Message}");
        }
    }
}


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

