using System.Text.Json;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.ThemeStudio.Themes;

internal static class ThemeJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
        WriteIndented = false,
    };

    public static T? TryDeserialize<T>(string? json)
        where T : class
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize<T>(json, Options);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, Options);
}
