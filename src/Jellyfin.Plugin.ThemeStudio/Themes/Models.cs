using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.ThemeStudio.Themes;

/// <summary>
/// Design tokens of a theme. Every property is optional so the same type can
/// describe a full theme or a partial set of user overrides.
/// </summary>
public sealed class ThemeTokens
{
    public string? Accent { get; set; }

    public string? Background { get; set; }

    public string? Surface { get; set; }

    public string? Text { get; set; }

    public string? TextSecondary { get; set; }

    /// <summary>Gets or sets the corner radius in pixels.</summary>
    public int? Radius { get; set; }

    /// <summary>Gets or sets the blur (glass effect) in pixels.</summary>
    public int? Blur { get; set; }

    public string? Font { get; set; }

    /// <summary>Gets or sets an optional background image URL.</summary>
    public string? BackgroundImage { get; set; }

    /// <summary>Gets or sets how much the background image is darkened, 0-100.</summary>
    public int? BackgroundDim { get; set; }

    /// <summary>Returns a copy of this instance where every value set in <paramref name="overrides"/> wins.</summary>
    public ThemeTokens MergeWith(ThemeTokens? overrides)
    {
        if (overrides is null)
        {
            return (ThemeTokens)MemberwiseClone();
        }

        return new ThemeTokens
        {
            Accent = overrides.Accent ?? Accent,
            Background = overrides.Background ?? Background,
            Surface = overrides.Surface ?? Surface,
            Text = overrides.Text ?? Text,
            TextSecondary = overrides.TextSecondary ?? TextSecondary,
            Radius = overrides.Radius ?? Radius,
            Blur = overrides.Blur ?? Blur,
            Font = overrides.Font ?? Font,
            BackgroundImage = overrides.BackgroundImage ?? BackgroundImage,
            BackgroundDim = overrides.BackgroundDim ?? BackgroundDim,
        };
    }
}

/// <summary>A theme from the catalog.</summary>
public sealed class ThemeDefinition
{
    public string Id { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public string? Author { get; set; }

    public string? Description { get; set; }

    public string[] Tags { get; set; } = Array.Empty<string>();

    /// <summary>Gets or sets a value indicating whether this is the untouched Jellyfin look (engine disabled).</summary>
    public bool Stock { get; set; }

    public ThemeTokens Tokens { get; set; } = new();

    /// <summary>Gets or sets extra CSS appended after the engine.</summary>
    public string? Css { get; set; }

    /// <summary>Gets or sets where the theme comes from: "builtin" or "custom".</summary>
    [JsonPropertyName("source")]
    public string Source { get; set; } = "builtin";
}

/// <summary>What a user (or the server default) has chosen.</summary>
public sealed class ThemeSelection
{
    public string ThemeId { get; set; } = ThemeCatalog.DefaultThemeId;

    public ThemeTokens? Overrides { get; set; }

    public string? CustomCss { get; set; }
}
