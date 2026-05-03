#if UNITY_EDITOR
using System.IO;
using System.Linq;
using System.Text;
using UnityEditor;
using UnityEngine;

/// <summary>
/// Writes <c>StreamingAssets/web/_web_copy_manifest.txt</c> so <see cref="WebViewController"/> can copy every file on Android (jar) builds.
/// </summary>
public static class WebStreamingManifestGenerator
{
    const string ManifestFileName = "_web_copy_manifest.txt";

    static string RelativeToWebFolder(string webAbs, string fileAbs)
    {
        var root = Path.GetFullPath(webAbs.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar);
        var full = Path.GetFullPath(fileAbs);
        if (!full.StartsWith(root, System.StringComparison.OrdinalIgnoreCase))
            return Path.GetFileName(fileAbs);
        return full.Substring(root.Length).Replace('\\', '/');
    }

    [MenuItem("Tools/Web Package/Generate StreamingAssets Web Manifest")]
    public static void Generate()
    {
        var webAbs = Path.Combine(Application.dataPath, "StreamingAssets", "web");
        if (!Directory.Exists(webAbs))
        {
            EditorUtility.DisplayDialog(
                "Web manifest",
                "Folder not found:\n" + webAbs,
                "OK");
            return;
        }

        var lines = Directory
            .GetFiles(webAbs, "*", SearchOption.AllDirectories)
            .Select(p => RelativeToWebFolder(webAbs, p))
            .Where(rel => !string.Equals(rel, ManifestFileName, System.StringComparison.OrdinalIgnoreCase))
            .OrderBy(rel => rel, System.StringComparer.OrdinalIgnoreCase)
            .ToList();

        var sb = new StringBuilder();
        sb.AppendLine("# Paths relative to the web/ folder — used on Android/iOS when StreamingAssets is inside the APK.");
        sb.AppendLine("# Regenerate from Unity: Tools → Web Package → Generate StreamingAssets Web Manifest");
        foreach (var rel in lines)
            sb.AppendLine(rel);

        var manifestPath = Path.Combine(webAbs, ManifestFileName);
        File.WriteAllText(manifestPath, sb.ToString(), new UTF8Encoding(false));
        AssetDatabase.Refresh();
        Debug.Log("[Web manifest] Wrote " + lines.Count + " paths to " + manifestPath);
    }
}
#endif
