using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.ThemeStudio.Themes;

/// <summary>
/// Turns a theme + selection into the final stylesheet. The same logic exists in
/// Web/client.js for the live preview; keep both in sync.
/// </summary>
public static partial class ThemeCssBuilder
{
    public static string Build(ThemeDefinition theme, ThemeSelection? selection, string? adminCss = null)
    {
        var sb = new StringBuilder();
        var hasOverrides = selection?.Overrides is not null && HasAnyValue(selection.Overrides);

        if (!theme.Stock || hasOverrides)
        {
            var tokens = theme.Tokens.MergeWith(selection?.Overrides);
            sb.Append(":root{").Append(Variables(tokens)).Append("}\n");
            sb.Append(ThemeCatalog.ReadResource("engine.css")).Append('\n');
        }

        if (!string.IsNullOrWhiteSpace(theme.Css))
        {
            sb.Append(theme.Css).Append('\n');
        }

        if (!string.IsNullOrWhiteSpace(adminCss))
        {
            sb.Append(adminCss).Append('\n');
        }

        if (!string.IsNullOrWhiteSpace(selection?.CustomCss))
        {
            sb.Append(selection.CustomCss).Append('\n');
        }

        return sb.ToString();
    }

    public static string Variables(ThemeTokens t)
    {
        var sb = new StringBuilder();
        void Add(string name, string? value)
        {
            if (!string.IsNullOrWhiteSpace(value))
            {
                sb.Append("--ts-").Append(name).Append(':').Append(value).Append(';');
            }
        }

        Add("accent", SafeColor(t.Accent));
        Add("bg", SafeColor(t.Background));
        Add("surface", SafeColor(t.Surface));
        Add("text", SafeColor(t.Text));
        Add("text-2", SafeColor(t.TextSecondary));
        Add("radius", t.Radius is int r ? Math.Clamp(r, 0, 40).ToString(CultureInfo.InvariantCulture) + "px" : null);
        Add("blur", t.Blur is int b ? Math.Clamp(b, 0, 60).ToString(CultureInfo.InvariantCulture) + "px" : null);
        Add("font", SafeFont(t.Font));
        if (!string.IsNullOrWhiteSpace(t.BackgroundImage))
        {
            // The darkening gradient is part of the image layer so nothing is dimmed when there is no image.
            var dim = (Math.Clamp(t.BackgroundDim ?? 60, 0, 100) / 100.0).ToString("0.##", CultureInfo.InvariantCulture);
            var url = t.BackgroundImage.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "%22", StringComparison.Ordinal).Replace("\n", string.Empty, StringComparison.Ordinal);
            Add("bg-image", $"linear-gradient(rgba(0,0,0,{dim}),rgba(0,0,0,{dim})),url(\"{url}\")");
        }

        return sb.ToString();
    }

    private static bool HasAnyValue(ThemeTokens t)
        => (t.Accent ?? t.Background ?? t.Surface ?? t.Text ?? t.TextSecondary ?? t.Font ?? t.BackgroundImage) is not null
           || t.Radius.HasValue || t.Blur.HasValue || t.BackgroundDim.HasValue;

    private static string? SafeColor(string? value)
        => value is not null && SafeColorRegex().IsMatch(value) ? value : null;

    private static string? SafeFont(string? value)
        => value is not null && SafeFontRegex().IsMatch(value) ? value : null;

    [GeneratedRegex(@"^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla|oklch)\([0-9a-zA-Z.,%\s/-]+\))$")]
    private static partial Regex SafeColorRegex();

    [GeneratedRegex(@"^[\w\s,""'-]{1,200}$")]
    private static partial Regex SafeFontRegex();
}
