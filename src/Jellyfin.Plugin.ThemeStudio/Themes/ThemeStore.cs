using System.Collections.Concurrent;

namespace Jellyfin.Plugin.ThemeStudio.Themes;

/// <summary>
/// Reads and writes server settings (plugin configuration) and per-user choices
/// (one JSON file per user in the plugin data folder, so they sync across devices).
/// </summary>
public class ThemeStore
{
    private static readonly ConcurrentDictionary<Guid, object> UserLocks = new();

    private readonly string _usersFolder;

    public ThemeStore(string dataFolder)
    {
        _usersFolder = Path.Combine(dataFolder, "users");
    }

    /// <summary>
    /// Gets the store for the running plugin. Data lives next to the plugin configuration
    /// (plugins/configurations/ThemeStudio) so it survives plugin updates.
    /// </summary>
    public static ThemeStore? Current => Plugin.Instance is { } p
        ? new ThemeStore(Path.Combine(Path.GetDirectoryName(p.ConfigurationFilePath)!, "ThemeStudio"))
        : null;

    public virtual ServerSettings GetServerSettings()
    {
        var config = Plugin.Instance?.Configuration ?? new Configuration.PluginConfiguration();
        return new ServerSettings
        {
            AllowUserThemes = config.AllowUserThemes,
            ShowHeaderButton = config.ShowHeaderButton,
            DefaultSelection = ThemeJson.TryDeserialize<ThemeSelection>(config.DefaultSelectionJson) ?? new ThemeSelection(),
            CustomThemes = ThemeJson.TryDeserialize<List<ThemeDefinition>>(config.CustomThemesJson) ?? new List<ThemeDefinition>(),
        };
    }

    public virtual void SaveServerSettings(ServerSettings settings)
    {
        var plugin = Plugin.Instance ?? throw new InvalidOperationException("Plugin not initialised");
        var config = plugin.Configuration;
        config.AllowUserThemes = settings.AllowUserThemes;
        config.ShowHeaderButton = settings.ShowHeaderButton;
        config.DefaultSelectionJson = ThemeJson.Serialize(settings.DefaultSelection ?? new ThemeSelection());
        var custom = (settings.CustomThemes ?? new List<ThemeDefinition>())
            .Select(t =>
            {
                t.Id = ThemeCatalog.NormalizeId(t.Id, t.Name);
                t.Source = "custom";
                return t;
            })
            .Where(t => ThemeCatalog.BuiltIn.All(b => b.Id != t.Id))
            .GroupBy(t => t.Id)
            .Select(g => g.Last())
            .ToList();
        config.CustomThemesJson = ThemeJson.Serialize(custom);
        plugin.SaveConfiguration();
    }

    public ThemeSelection? GetUserSelection(Guid userId)
    {
        var path = UserPath(userId);
        lock (UserLocks.GetOrAdd(userId, _ => new object()))
        {
            return File.Exists(path) ? ThemeJson.TryDeserialize<ThemeSelection>(File.ReadAllText(path)) : null;
        }
    }

    public void SaveUserSelection(Guid userId, ThemeSelection? selection)
    {
        var path = UserPath(userId);
        lock (UserLocks.GetOrAdd(userId, _ => new object()))
        {
            if (selection is null)
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                }

                return;
            }

            Directory.CreateDirectory(_usersFolder);
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, ThemeJson.Serialize(selection));
            File.Move(tmp, path, overwrite: true);
        }
    }

    /// <summary>The CSS everybody gets before logging in (login page) and by default.</summary>
    public string BuildDefaultCss()
    {
        var settings = GetServerSettings();
        var themes = ThemeCatalog.All(settings.CustomThemes);
        var theme = ThemeCatalog.Find(themes, settings.DefaultSelection?.ThemeId);
        return ThemeCssBuilder.Build(theme, settings.DefaultSelection);
    }

    private string UserPath(Guid userId) => Path.Combine(_usersFolder, userId.ToString("N") + ".json");
}

/// <summary>Server-wide settings as exposed to the admin page.</summary>
public sealed class ServerSettings
{
    public bool AllowUserThemes { get; set; } = true;

    public bool ShowHeaderButton { get; set; } = true;

    public ThemeSelection? DefaultSelection { get; set; } = new();

    public List<ThemeDefinition>? CustomThemes { get; set; } = new();
}
