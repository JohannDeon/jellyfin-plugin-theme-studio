using Jellyfin.Plugin.ThemeStudio.Themes;
using Xunit;

namespace Jellyfin.Plugin.ThemeStudio.Tests;

public class ThemeTests
{
    [Fact]
    public void BuiltInCatalogLoads()
    {
        var themes = ThemeCatalog.BuiltIn;
        Assert.True(themes.Count >= 8);
        Assert.Contains(themes, t => t.Id == ThemeCatalog.DefaultThemeId && t.Stock);
        Assert.All(themes, t =>
        {
            Assert.False(string.IsNullOrWhiteSpace(t.Name));
            Assert.NotNull(t.Tokens.Accent);
            Assert.NotNull(t.Tokens.Background);
        });
        Assert.Equal(themes.Count, themes.Select(t => t.Id).Distinct().Count());
    }

    [Fact]
    public void StockThemeWithoutOverridesProducesNoCss()
    {
        var stock = ThemeCatalog.Find(ThemeCatalog.BuiltIn, "jellyfin");
        Assert.Equal(string.Empty, ThemeCssBuilder.Build(stock, new ThemeSelection()));
    }

    [Fact]
    public void ThemeCssContainsVariablesEngineAndUserCss()
    {
        var theme = ThemeCatalog.Find(ThemeCatalog.BuiltIn, "minuit");
        var css = ThemeCssBuilder.Build(theme, new ThemeSelection
        {
            ThemeId = "minuit",
            Overrides = new ThemeTokens { Accent = "#ff0000", Radius = 99 },
            CustomCss = ".x{color:red}",
        });

        Assert.StartsWith(":root{", css, StringComparison.Ordinal);
        Assert.Contains("--ts-accent:#ff0000;", css, StringComparison.Ordinal);
        Assert.Contains("--ts-radius:40px;", css, StringComparison.Ordinal); // clamped
        Assert.Contains("--ts-bg:#0b1020;", css, StringComparison.Ordinal); // from theme
        Assert.Contains(".skinHeader", css, StringComparison.Ordinal); // engine
        Assert.EndsWith(".x{color:red}\n", css, StringComparison.Ordinal);
    }

    [Fact]
    public void RejectsUnsafeTokenValues()
    {
        var vars = ThemeCssBuilder.Variables(new ThemeTokens
        {
            Accent = "red;} body{display:none",
            Font = "x;}",
            BackgroundImage = "https://a/b\".png",
        });
        Assert.DoesNotContain("display:none", vars, StringComparison.Ordinal);
        Assert.DoesNotContain("--ts-font", vars, StringComparison.Ordinal);
        Assert.Contains("url(\"https://a/b%22.png\")", vars, StringComparison.Ordinal);
    }

    [Fact]
    public void UnknownThemeFallsBackToStock()
        => Assert.Equal("jellyfin", ThemeCatalog.Find(ThemeCatalog.BuiltIn, "nope").Id);

    [Theory]
    [InlineData(null, "Mon Thème!", "mon-th-me")]
    [InlineData("Cool_Theme", "x", "cool-theme")]
    public void NormalizesIds(string? id, string name, string expected)
        => Assert.Equal(expected, ThemeCatalog.NormalizeId(id, name));

    [Fact]
    public void UserSelectionRoundTrips()
    {
        var dir = Path.Combine(Path.GetTempPath(), "ts-" + Guid.NewGuid().ToString("N"));
        var store = new ThemeStore(dir);
        var user = Guid.NewGuid();
        Assert.Null(store.GetUserSelection(user));

        store.SaveUserSelection(user, new ThemeSelection { ThemeId = "oled", Overrides = new ThemeTokens { Blur = 5 } });
        var back = store.GetUserSelection(user);
        Assert.Equal("oled", back!.ThemeId);
        Assert.Equal(5, back.Overrides!.Blur);

        store.SaveUserSelection(user, null);
        Assert.Null(store.GetUserSelection(user));
        Directory.Delete(dir, true);
    }
}
