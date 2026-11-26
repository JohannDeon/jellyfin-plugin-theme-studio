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

        // Old TV browsers (LG webOS, Samsung Tizen) have no color-mix(): the engine uses
        // rgba(var(--ts-*-rgb), alpha) instead, so expose each color as an "r,g,b" triplet.
        var accent = ToRgb(SafeColor(t.Accent));
        var bg = ToRgb(SafeColor(t.Background));
        var surface = ToRgb(SafeColor(t.Surface));
        var text = ToRgb(SafeColor(t.Text));
        Add("accent-rgb", Triplet(accent));
        Add("bg-rgb", Triplet(bg));
        Add("surface-rgb", Triplet(surface));
        Add("text-rgb", Triplet(text));
        Add("text-2-rgb", Triplet(ToRgb(SafeColor(t.TextSecondary))));
        if (surface is { } sf && text is { } tx)
        {
            Add("surface-2-rgb", Triplet((Mix(sf.R, tx.R), Mix(sf.G, tx.G), Mix(sf.B, tx.B))));
        }
        if (!string.IsNullOrWhiteSpace(t.BackgroundImage))
        {
            // The darkening gradient is part of the image layer so nothing is dimmed when there is no image.
            var dim = (Math.Clamp(t.BackgroundDim ?? 60, 0, 100) / 100.0).ToString("0.##", CultureInfo.InvariantCulture);
            var url = t.BackgroundImage.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "%22", StringComparison.Ordinal).Replace("\n", string.Empty, StringComparison.Ordinal);
            Add("bg-image", $"linear-gradient(rgba(0,0,0,{dim}),rgba(0,0,0,{dim})),url(\"{url}\")");
        }

        return sb.ToString();
    }

    internal static (int R, int G, int B)? ToRgb(string? color)
    {
        if (string.IsNullOrEmpty(color))
        {
            return null;
        }

        if (color[0] == '#')
        {
            var h = color[1..];
            if (h.Length is 3 or 4)
            {
                h = string.Concat(h[0], h[0], h[1], h[1], h[2], h[2]);
            }

            if (h.Length < 6)
            {
                return null;
            }

            return (Convert.ToInt32(h[0..2], 16), Convert.ToInt32(h[2..4], 16), Convert.ToInt32(h[4..6], 16));
        }

        var m = RgbFunctionRegex().Match(color);
        if (m.Success)
        {
            return (Channel(m.Groups[1].Value), Channel(m.Groups[2].Value), Channel(m.Groups[3].Value));
        }

        return null;
    }

    private static int Channel(string v)
        => Math.Clamp((int)Math.Round(double.Parse(v, CultureInfo.InvariantCulture)), 0, 255);

    private static int Mix(int surface, int text) => (int)Math.Round((surface * 0.92) + (text * 0.08));

    private static string? Triplet((int R, int G, int B)? c)
        => c is { } v ? string.Create(CultureInfo.InvariantCulture, $"{v.R},{v.G},{v.B}") : null;

    private static bool HasAnyValue(ThemeTokens t)
        => (t.Accent ?? t.Background ?? t.Surface ?? t.Text ?? t.TextSecondary ?? t.Font ?? t.BackgroundImage) is not null
           || t.Radius.HasValue || t.Blur.HasValue || t.BackgroundDim.HasValue;

    private static string? SafeColor(string? value)
        => value is not null && SafeColorRegex().IsMatch(value) ? value : null;

    private static string? SafeFont(string? value)
        => value is not null && SafeFontRegex().IsMatch(value) ? value : null;

    [GeneratedRegex(@"^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla|oklch)\([0-9a-zA-Z.,%\s/-]+\))$")]
    private static partial Regex SafeColorRegex();

    [GeneratedRegex(@"^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)")]
    private static partial Regex RgbFunctionRegex();

    [GeneratedRegex(@"^[\w\s,""'-]{1,200}$")]
    private static partial Regex SafeFontRegex();
}
