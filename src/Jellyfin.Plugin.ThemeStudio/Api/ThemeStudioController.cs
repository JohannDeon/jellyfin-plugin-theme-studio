using System.Net.Mime;
using Jellyfin.Plugin.ThemeStudio.Injection;
using Jellyfin.Plugin.ThemeStudio.Themes;
using MediaBrowser.Controller.Net;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.ThemeStudio.Api;

/// <summary>HTTP API used by the injected client and the admin page.</summary>
[ApiController]
[Route("ThemeStudio")]
public class ThemeStudioController : ControllerBase
{
    private const string ElevationPolicy = "RequiresElevation";

    private readonly IAuthorizationContext _authContext;

    public ThemeStudioController(IAuthorizationContext authContext)
    {
        _authContext = authContext;
    }

    private static ThemeStore Store => ThemeStore.Current ?? throw new InvalidOperationException("Theme Studio is not initialised");

    /// <summary>The injected client script.</summary>
    [HttpGet("client.js")]
    [AllowAnonymous]
    [Produces("application/javascript")]
    public ContentResult GetClient()
    {
        Response.Headers.CacheControl = "public, max-age=3600";
        return Content(ThemeCatalog.ReadResource("client.js"), "application/javascript; charset=utf-8");
    }

    /// <summary>The server default stylesheet (also used on the login page).</summary>
    [HttpGet("default.css")]
    [AllowAnonymous]
    [Produces("text/css")]
    public ContentResult GetDefaultCss()
    {
        Response.Headers.CacheControl = "no-cache";
        return Content(Store.BuildDefaultCss(), "text/css; charset=utf-8");
    }

    /// <summary>The theme engine (CSS variables mapped onto Jellyfin Web).</summary>
    [HttpGet("engine.css")]
    [AllowAnonymous]
    [Produces("text/css")]
    public ContentResult GetEngineCss()
    {
        Response.Headers.CacheControl = "public, max-age=3600";
        return Content(ThemeCatalog.ReadResource("engine.css"), "text/css; charset=utf-8");
    }

    /// <summary>Everything the client needs after login.</summary>
    [HttpGet("Bootstrap")]
    [Authorize]
    [Produces(MediaTypeNames.Application.Json)]
    public async Task<ActionResult> GetBootstrap()
    {
        var userId = await GetUserIdAsync().ConfigureAwait(false);
        var settings = Store.GetServerSettings();
        return Json(new BootstrapResponse
        {
            Themes = ThemeCatalog.All(settings.CustomThemes),
            DefaultSelection = settings.DefaultSelection ?? new ThemeSelection(),
            UserSelection = settings.AllowUserThemes && userId != Guid.Empty ? Store.GetUserSelection(userId) : null,
            AllowUserThemes = settings.AllowUserThemes,
            ShowHeaderButton = settings.ShowHeaderButton,
            IsAdmin = User.IsInRole("Administrator"),
            Version = typeof(Plugin).Assembly.GetName().Version?.ToString() ?? "0",
        });
    }

    /// <summary>Saves the current user's theme.</summary>
    [HttpPut("Me")]
    [Authorize]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public async Task<ActionResult> SaveMine()
    {
        var selection = await ReadBodyAsync<ThemeSelection>().ConfigureAwait(false);
        if (selection is null)
        {
            return BadRequest();
        }

        if (!Store.GetServerSettings().AllowUserThemes)
        {
            return Forbid();
        }

        var userId = await GetUserIdAsync().ConfigureAwait(false);
        if (userId == Guid.Empty)
        {
            return Unauthorized();
        }

        Store.SaveUserSelection(userId, selection);
        return NoContent();
    }

    /// <summary>Removes the current user's theme so the server default applies again.</summary>
    [HttpDelete("Me")]
    [Authorize]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public async Task<ActionResult> ResetMine()
    {
        var userId = await GetUserIdAsync().ConfigureAwait(false);
        if (userId == Guid.Empty)
        {
            return Unauthorized();
        }

        Store.SaveUserSelection(userId, null);
        return NoContent();
    }

    /// <summary>Server settings for the admin page.</summary>
    [HttpGet("Admin")]
    [Authorize(Policy = ElevationPolicy)]
    [Produces(MediaTypeNames.Application.Json)]
    public ActionResult GetAdmin()
        => Json(new AdminResponse
        {
            Settings = Store.GetServerSettings(),
            BuiltInThemes = ThemeCatalog.BuiltIn,
            LastInjection = IndexHtmlInjectionMiddleware.LastInjection,
        });

    /// <summary>Saves the server settings.</summary>
    [HttpPut("Admin")]
    [Authorize(Policy = ElevationPolicy)]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public async Task<ActionResult> SaveAdmin()
    {
        var settings = await ReadBodyAsync<ServerSettings>().ConfigureAwait(false);
        if (settings is null)
        {
            return BadRequest();
        }

        Store.SaveServerSettings(settings);
        return NoContent();
    }

    // Jellyfin's MVC JSON settings use PascalCase; the client speaks camelCase,
    // so this API serializes and parses its own JSON with ThemeJson.Options.
    private ContentResult Json<T>(T value)
        => Content(ThemeJson.Serialize(value), MediaTypeNames.Application.Json);

    private async Task<T?> ReadBodyAsync<T>()
        where T : class
    {
        using var reader = new StreamReader(Request.Body);
        var body = await reader.ReadToEndAsync().ConfigureAwait(false);
        return ThemeJson.TryDeserialize<T>(body);
    }

    private async Task<Guid> GetUserIdAsync()
    {
        var info = await _authContext.GetAuthorizationInfo(Request).ConfigureAwait(false);
        return info.UserId;
    }
}

public sealed class BootstrapResponse
{
    public IReadOnlyList<ThemeDefinition> Themes { get; set; } = Array.Empty<ThemeDefinition>();

    public ThemeSelection DefaultSelection { get; set; } = new();

    public ThemeSelection? UserSelection { get; set; }

    public bool AllowUserThemes { get; set; }

    public bool ShowHeaderButton { get; set; }

    public bool IsAdmin { get; set; }

    public string Version { get; set; } = string.Empty;
}

public sealed class AdminResponse
{
    public ServerSettings Settings { get; set; } = new();

    public IReadOnlyList<ThemeDefinition> BuiltInThemes { get; set; } = Array.Empty<ThemeDefinition>();

    public DateTimeOffset? LastInjection { get; set; }
}
