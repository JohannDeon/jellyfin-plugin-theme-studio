using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.ThemeStudio.Configuration;

/// <summary>
/// Server-wide settings. Complex values are stored as JSON strings so the XML
/// configuration file stays simple and forward compatible.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>Gets or sets a value indicating whether users may pick their own theme.</summary>
    public bool AllowUserThemes { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether the palette button is shown in the header.</summary>
    public bool ShowHeaderButton { get; set; } = true;

    /// <summary>Gets or sets the default selection (theme + overrides + CSS) as JSON.</summary>
    public string DefaultSelectionJson { get; set; } = string.Empty;

    /// <summary>Gets or sets the admin-created themes as a JSON array.</summary>
    public string CustomThemesJson { get; set; } = string.Empty;
}
