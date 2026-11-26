using System.IO.Compression;
using System.Net;
using System.Text;
using Jellyfin.Plugin.ThemeStudio.Injection;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Xunit;

namespace Jellyfin.Plugin.ThemeStudio.Tests;

public class InjectionTests
{
    private const string Index = "<!DOCTYPE html><html><head><title>Jellyfin</title></head><body></body></html>";

    /// <summary>A pipeline shaped like Jellyfin's: base URL, response compression, static web files.</summary>
    private static async Task<IHost> StartAsync(string baseUrl = "")
    {
        var host = new HostBuilder()
            .ConfigureWebHost(web => web
                .UseTestServer()
                .ConfigureServices(s =>
                {
                    s.AddResponseCompression(o => o.EnableForHttps = true);
                    // Registered the same way the plugin does it in PluginServiceRegistrator.
                    s.AddTransient<IStartupFilter, InjectionStartupFilter>();
                })
                .Configure(app =>
                {
                    app.UseResponseCompression();
                    app.Map(baseUrl + "/web", web => web.Run(async ctx =>
                    {
                        ctx.Response.ContentType = "text/html";
                        ctx.Response.Headers.ETag = "\"abc\"";
                        await ctx.Response.WriteAsync(Index + new string(' ', 2000));
                    }));
                    app.Run(ctx => ctx.Response.WriteAsync("other"));
                }))
            .Build();
        await host.StartAsync();
        return host;
    }

    [Theory]
    [InlineData("", "/web/")]
    [InlineData("", "/web/index.html")]
    [InlineData("/jellyfin", "/jellyfin/web/index.html")]
    public async Task InjectsScriptAndStylesheet(string baseUrl, string path)
    {
        using var host = await StartAsync(baseUrl);
        var client = host.GetTestClient();
        var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.TryAddWithoutValidation("Accept-Encoding", "gzip, br");
        request.Headers.TryAddWithoutValidation("If-None-Match", "\"abc\"");

        var response = await client.SendAsync(request);
        var html = await response.Content.ReadAsStringAsync();

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains($"src=\"{baseUrl}/ThemeStudio/client.js", html, StringComparison.Ordinal);
        Assert.Contains($"href=\"{baseUrl}/ThemeStudio/default.css\"", html, StringComparison.Ordinal);
        Assert.True(html.IndexOf("theme-studio", StringComparison.Ordinal) < html.IndexOf("</head>", StringComparison.Ordinal));
        Assert.Empty(response.Content.Headers.ContentEncoding);
        Assert.Null(response.Headers.ETag);
        Assert.NotNull(IndexHtmlInjectionMiddleware.LastInjection);
    }

    [Fact]
    public async Task LeavesOtherRequestsAlone()
    {
        using var host = await StartAsync();
        var body = await host.GetTestClient().GetStringAsync("/Items");
        Assert.Equal("other", body);
    }

    [Fact]
    public void InjectIsIdempotent()
    {
        var once = IndexHtmlInjectionMiddleware.Inject(Index, string.Empty);
        Assert.Equal(once, IndexHtmlInjectionMiddleware.Inject(once, string.Empty));
    }

    [Theory]
    [InlineData("/web/", true, "")]
    [InlineData("/media/web/index.html", true, "/media")]
    [InlineData("/web/main.js", false, "")]
    [InlineData("/ThemeStudio/client.js", false, "")]
    public void DetectsIndexPage(string path, bool expected, string prefix)
    {
        Assert.Equal(expected, IndexHtmlInjectionMiddleware.TryGetPrefix(path, out var p));
        if (expected)
        {
            Assert.Equal(prefix, p);
        }
    }
}
