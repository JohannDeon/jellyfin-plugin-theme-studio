using System.Reflection;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.ThemeStudio.Themes;

/// <summary>Built-in themes (embedded) plus the admin's custom themes.</summary>
public static partial class ThemeCatalog
{
    public const string DefaultThemeId = "jellyfin";

    private static readonly Lazy<IReadOnlyList<ThemeDefinition>> BuiltInThemes = new(LoadBuiltIn);

    public static IReadOnlyList<ThemeDefinition> BuiltIn => BuiltInThemes.Value;

    public static IReadOnlyList<ThemeDefinition> All(IEnumerable<ThemeDefinition>? custom)
    {
        var list = new List<ThemeDefinition>(BuiltIn);
        if (custom is not null)
        {
            foreach (var theme in custom)
            {
                if (list.Exists(t => t.Id == theme.Id))
                {
                    continue;
                }

                theme.Source = "custom";
                list.Add(theme);
            }
        }

        return list;
    }

    public static ThemeDefinition Find(IReadOnlyList<ThemeDefinition> themes, string? id)
        => themes.FirstOrDefault(t => string.Equals(t.Id, id, StringComparison.OrdinalIgnoreCase))
           ?? themes.First(t => t.Id == DefaultThemeId);

    /// <summary>Makes a theme id safe and unique-ish: lowercase letters, digits and dashes.</summary>
    public static string NormalizeId(string? id, string fallbackName)
    {
        var source = string.IsNullOrWhiteSpace(id) ? fallbackName : id;
        var normalized = InvalidIdChars().Replace(source.Trim().ToLowerInvariant(), "-").Trim('-');
        return string.IsNullOrEmpty(normalized) ? "theme-" + Guid.NewGuid().ToString("N")[..8] : normalized;
    }

    internal static string ReadResource(string fileName)
    {
        var assembly = typeof(ThemeCatalog).Assembly;
        var name = assembly.GetManifestResourceNames().First(n => n.EndsWith("." + fileName, StringComparison.Ordinal));
        using var stream = assembly.GetManifestResourceStream(name)!;
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    private static IReadOnlyList<ThemeDefinition> LoadBuiltIn()
    {
        var themes = ThemeJson.TryDeserialize<List<ThemeDefinition>>(ReadResource("themes.json"))
                     ?? throw new InvalidOperationException("themes.json is invalid");
        foreach (var theme in themes)
        {
            theme.Source = "builtin";
        }

        return themes;
    }

    [GeneratedRegex("[^a-z0-9]+")]
    private static partial Regex InvalidIdChars();
}
