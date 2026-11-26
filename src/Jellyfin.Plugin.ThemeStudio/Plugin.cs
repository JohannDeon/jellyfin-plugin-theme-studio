using Jellyfin.Plugin.ThemeStudio.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.ThemeStudio;

/// <summary>
/// Theme Studio: modern, per-user theme manager for Jellyfin Web.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public static readonly Guid PluginId = new("f5ce6c30-0794-441d-a8d8-da5f0cd72eed");

    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    public static Plugin? Instance { get; private set; }

    public override string Name => "Theme Studio";

    public override string Description => "Thèmes modernes pour Jellyfin : aperçu en direct, thème par utilisateur, éditeur visuel.";

    public override Guid Id => PluginId;

    public IEnumerable<PluginPageInfo> GetPages()
    {
        yield return new PluginPageInfo
        {
            Name = "ThemeStudio",
            DisplayName = "Theme Studio",
            EmbeddedResourcePath = GetType().Namespace + ".Configuration.configPage.html",
            EnableInMainMenu = true,
            MenuIcon = "palette",
        };
    }
}
