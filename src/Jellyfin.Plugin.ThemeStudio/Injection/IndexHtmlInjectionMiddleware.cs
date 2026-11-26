using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.ThemeStudio.Injection;

/// <summary>
/// Adds Theme Studio's stylesheet and script to Jellyfin Web's index.html as it is
/// served, so nothing has to be edited on disk (works in Docker, read-only installs, etc.).
/// </summary>
public sealed class IndexHtmlInjectionMiddleware
{
    public const string Marker = "<!-- theme-studio -->";

    private readonly RequestDelegate _next;

    public IndexHtmlInjectionMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    /// <summary>Gets the last time index.html was rewritten (shown as a diagnostic on the admin page).</summary>
    public static DateTimeOffset? LastInjection { get; private set; }

    public async Task InvokeAsync(HttpContext context)
    {
        var request = context.Request;
        var fullPath = (request.PathBase.Value ?? string.Empty) + (request.Path.Value ?? string.Empty);
        if (!HttpMethods.IsGet(request.Method) || !TryGetPrefix(fullPath, out var prefix))
        {
            await _next(context).ConfigureAwait(false);
            return;
        }

        // We need the plain, full body: no compression, no 304.
        request.Headers.Remove(HeaderNames.AcceptEncoding);
        request.Headers.Remove(HeaderNames.IfNoneMatch);
        request.Headers.Remove(HeaderNames.IfModifiedSince);

        var originalBody = context.Response.Body;
        await using var buffer = new MemoryStream();
        context.Response.Body = buffer;
        try
        {
            await _next(context).ConfigureAwait(false);
        }
        finally
        {
            context.Response.Body = originalBody;
        }

        buffer.Position = 0;
        var response = context.Response;
        var isHtml = response.ContentType?.Contains("text/html", StringComparison.OrdinalIgnoreCase) == true;
        if (response.StatusCode == StatusCodes.Status200OK && isHtml && !response.Headers.ContainsKey(HeaderNames.ContentEncoding))
        {
            var html = Encoding.UTF8.GetString(buffer.ToArray());
            var injected = Inject(html, prefix);
            var bytes = Encoding.UTF8.GetBytes(injected);
            response.ContentLength = bytes.Length;
            response.Headers.Remove(HeaderNames.ETag);
            response.Headers.Remove(HeaderNames.LastModified);
            response.Headers.CacheControl = "no-cache";
            LastInjection = DateTimeOffset.UtcNow;
            await originalBody.WriteAsync(bytes).ConfigureAwait(false);
        }
        else
        {
            await buffer.CopyToAsync(originalBody).ConfigureAwait(false);
        }
    }

    /// <summary>Returns true for Jellyfin Web's entry page and gives the URL prefix before "/web" (base URL).</summary>
    internal static bool TryGetPrefix(string path, out string prefix)
    {
        prefix = string.Empty;
        foreach (var suffix in new[] { "/web/index.html", "/web/" })
        {
            if (path.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
            {
                prefix = path[..^suffix.Length];
                return true;
            }
        }

        return false;
    }

    internal static string Inject(string html, string prefix)
    {
        if (html.Contains(Marker, StringComparison.Ordinal))
        {
            return html;
        }

        var version = typeof(IndexHtmlInjectionMiddleware).Assembly.GetName().Version?.ToString() ?? "1";
        var tags = Marker
                   + $"<link rel=\"stylesheet\" id=\"theme-studio-default\" href=\"{prefix}/ThemeStudio/default.css\">"
                   + $"<script src=\"{prefix}/ThemeStudio/client.js?v={version}\" data-base=\"{prefix}\"></script>";

        var headEnd = html.IndexOf("</head>", StringComparison.OrdinalIgnoreCase);
        return headEnd >= 0 ? html.Insert(headEnd, tags) : tags + html;
    }
}
