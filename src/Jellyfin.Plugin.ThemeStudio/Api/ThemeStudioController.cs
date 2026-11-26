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
    public async Task<ActionResult<BootstrapResponse>> GetBootstrap()
    {
        var userId = await GetUserIdAsync().ConfigureAwait(false);
        var settings = Store.GetServerSettings();
        return new BootstrapResponse
        {
            Themes = ThemeCatalog.All(settings.CustomThemes),
            DefaultSelection = settings.DefaultSelection ?? new ThemeSelection(),
            UserSelection = settings.AllowUserThemes && userId != Guid.Empty ? Store.GetUserSelection(userId) : null,
            AllowUserThemes = settings.AllowUserThemes,
            ShowHeaderButton = settings.ShowHeaderButton,
            IsAdmin = User.IsInRole("Administrator"),
            Version = typeof(Plugin).Assembly.GetName().Version?.ToString() ?? "0",
        };
    }

    /// <summary>Saves the current user's theme.</summary>
    [HttpPut("Me")]
    [Authorize]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public async Task<ActionResult> SaveMine([FromBody] ThemeSelection selection)
    {
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
    public ActionResult<AdminResponse> GetAdmin()
        => new AdminResponse
        {
            Settings = Store.GetServerSettings(),
            BuiltInThemes = ThemeCatalog.BuiltIn,
            LastInjection = IndexHtmlInjectionMiddleware.LastInjection,
        };

    /// <summary>Saves the server settings.</summary>
    [HttpPut("Admin")]
    [Authorize(Policy = ElevationPolicy)]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public ActionResult SaveAdmin([FromBody] ServerSettings settings)
    {
        Store.SaveServerSettings(settings);
        return NoContent();
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
