using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Gree.UnityWebView;
using UnityEngine;
#if UNITY_2018_4_OR_NEWER
using UnityEngine.Networking;
#endif

/// <summary>
/// Loads StreamingAssets offline. Copies the whole <c>web/</c> tree to the cache folder so <c>file://</c> subresources (css/js/images) resolve.
/// Only copying index.html leaves a blank white page because linked assets are still inside the APK.
/// </summary>
public class WebViewController : MonoBehaviour
{
    const string DefaultEntry = "web/index.html";
    const string ManifestName = "_web_copy_manifest.txt";

    [Tooltip("Path under StreamingAssets, e.g. web/index.html (folder name alone is treated as web/index.html).")]
    [SerializeField]
    string streamingAssetsRelativePath = DefaultEntry;

    [Tooltip("Leave empty for system WebView user-agent.")]
    [SerializeField]
    string customUserAgent = "";

#if UNITY_ANDROID || UNITY_IOS
    WebViewObject webViewObject;
    Camera[] camerasCleared;
    CameraClearFlags[] previousClearFlags;
    Color[] previousBgColors;
#endif

#if UNITY_ANDROID || UNITY_IOS
    void Awake()
    {
        var cams = FindObjectsByType<Camera>(FindObjectsInactive.Include, FindObjectsSortMode.None);
        if (cams == null || cams.Length == 0)
            return;
        camerasCleared = cams;
        previousClearFlags = new CameraClearFlags[cams.Length];
        previousBgColors = new Color[cams.Length];
        for (var i = 0; i < cams.Length; i++)
        {
            previousClearFlags[i] = cams[i].clearFlags;
            previousBgColors[i] = cams[i].backgroundColor;
            cams[i].clearFlags = CameraClearFlags.SolidColor;
            cams[i].backgroundColor = Color.black;
        }
    }
#endif

    void Start()
    {
#if UNITY_ANDROID || UNITY_IOS
        StartCoroutine(SetupWebView());
#endif
    }

#if UNITY_ANDROID || UNITY_IOS
    static bool StreamingAssetsPathIsUrl(string path)
    {
        return !string.IsNullOrEmpty(path) && path.IndexOf("://", System.StringComparison.Ordinal) >= 0;
    }

    static string NormalizeEntryRelativePath(string configured)
    {
        var rel = string.IsNullOrWhiteSpace(configured)
            ? DefaultEntry
            : configured.Trim().Replace('\\', '/');
        while (rel.Length > 1 && rel.EndsWith("/"))
            rel = rel.Substring(0, rel.Length - 1);
        if (rel.Length == 0)
            return DefaultEntry;
        if (!rel.EndsWith(".html", System.StringComparison.OrdinalIgnoreCase))
            rel = rel + "/index.html";
        return rel;
    }

    static string CombineStreamingAssetsUrl(string relativeUnderStreamingAssets)
    {
        relativeUnderStreamingAssets = relativeUnderStreamingAssets.Replace('\\', '/').TrimStart('/');
        var root = Application.streamingAssetsPath.Replace('\\', '/');
        if (root.EndsWith("/"))
            return root + relativeUnderStreamingAssets;
        return root + "/" + relativeUnderStreamingAssets;
    }

    static void EnsureDir(string path)
    {
        if (!string.IsNullOrEmpty(path) && !Directory.Exists(path))
            Directory.CreateDirectory(path);
    }

    static void CopyDirectoryRecursive(string sourceDir, string destDir)
    {
        EnsureDir(destDir);
        foreach (var file in Directory.GetFiles(sourceDir))
        {
            var name = Path.GetFileName(file);
            File.Copy(file, Path.Combine(destDir, name), true);
        }

        foreach (var dir in Directory.GetDirectories(sourceDir))
        {
            var name = Path.GetFileName(dir);
            CopyDirectoryRecursive(dir, Path.Combine(destDir, name));
        }
    }

    IEnumerator ReadStreamingAssetBytes(string relativeUnderStreamingAssets, System.Action<byte[]> onDone, System.Action<string> onError)
    {
        var url = CombineStreamingAssetsUrl(relativeUnderStreamingAssets);
#if UNITY_2018_4_OR_NEWER
        if (StreamingAssetsPathIsUrl(Application.streamingAssetsPath))
        {
            using (var req = UnityWebRequest.Get(url))
            {
                req.timeout = 120;
                yield return req.SendWebRequest();
                if (req.result != UnityWebRequest.Result.Success)
                {
                    onError?.Invoke(req.error + " url=" + url);
                    yield break;
                }

                onDone?.Invoke(req.downloadHandler.data);
            }
        }
        else
#endif
        {
            var diskPath = Path.Combine(Application.streamingAssetsPath, relativeUnderStreamingAssets.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(diskPath))
            {
                onError?.Invoke("Missing file: " + diskPath);
                yield break;
            }

            try
            {
                onDone?.Invoke(File.ReadAllBytes(diskPath));
            }
            catch (System.Exception ex)
            {
                onError?.Invoke(ex.Message);
            }
        }
    }

    IEnumerator CopyWebTreeToCache(string webRoot, string entryRelativePath)
    {
        var tempRoot = Application.temporaryCachePath;
        var srcWebDir = Path.Combine(Application.streamingAssetsPath, webRoot);
        var dstWebDir = Path.Combine(tempRoot, webRoot);

        if (!StreamingAssetsPathIsUrl(Application.streamingAssetsPath) && Directory.Exists(srcWebDir))
        {
            if (Directory.Exists(dstWebDir))
                Directory.Delete(dstWebDir, true);
            CopyDirectoryRecursive(srcWebDir, dstWebDir);
            yield break;
        }

        byte[] manifestBytes = null;
        string manifestErr = null;
        yield return ReadStreamingAssetBytes(webRoot + "/" + ManifestName, b => manifestBytes = b, e => manifestErr = e);
        if (manifestBytes == null || manifestBytes.Length == 0)
        {
            Debug.LogError(
                "[WebView] Missing or empty " + webRoot + "/" + ManifestName + " inside StreamingAssets. " +
                "Android/iOS cannot list APK assets; add the manifest or run Tools → Web Package → Generate StreamingAssets Web Manifest. " +
                manifestErr);
            yield break;
        }

        var text = Encoding.UTF8.GetString(manifestBytes);
        var lines = new List<string>();
        foreach (var raw in text.Split(new[] { '\r', '\n' }, System.StringSplitOptions.RemoveEmptyEntries))
        {
            var line = raw.Trim();
            if (line.Length == 0 || line.StartsWith("#"))
                continue;
            lines.Add(line.Replace('\\', '/'));
        }

        if (lines.Count == 0)
        {
            Debug.LogError("[WebView] Manifest has no file lines: " + webRoot + "/" + ManifestName);
            yield break;
        }

        if (Directory.Exists(dstWebDir))
            Directory.Delete(dstWebDir, true);

        foreach (var rel in lines)
        {
            var relUnderStreaming = webRoot + "/" + rel;
            byte[] data = null;
            string err = null;
            yield return ReadStreamingAssetBytes(relUnderStreaming, b => data = b, e => err = e);
            if (data == null)
            {
                Debug.LogError("[WebView] Failed to copy '" + relUnderStreaming + "': " + err);
                yield break;
            }

            var dstPath = Path.Combine(tempRoot, webRoot, rel.Replace('/', Path.DirectorySeparatorChar));
            EnsureDir(Path.GetDirectoryName(dstPath));
            File.WriteAllBytes(dstPath, data);
        }
    }

    IEnumerator SetupWebView()
    {
        var entryRel = NormalizeEntryRelativePath(streamingAssetsRelativePath);
        var webRoot = Path.GetDirectoryName(entryRel.Replace('/', Path.DirectorySeparatorChar));
        if (string.IsNullOrEmpty(webRoot))
            webRoot = "web";

        yield return CopyWebTreeToCache(webRoot, entryRel);

        var dstIndex = Path.Combine(Application.temporaryCachePath, entryRel.Replace('/', Path.DirectorySeparatorChar));
        if (!File.Exists(dstIndex))
        {
            Debug.LogError("[WebView] After copy, entry file is missing: " + dstIndex);
            yield break;
        }

        yield return null;

        var go = new GameObject("WebView");
        webViewObject = go.AddComponent<WebViewObject>();
        var ua = string.IsNullOrEmpty(customUserAgent) ? "" : customUserAgent.Trim();

        webViewObject.Init(
            cb: null,
            err: msg => Debug.LogError("[WebView] err: " + msg),
            httpErr: msg => Debug.LogWarning("[WebView] http: " + msg),
            ld: _ => RestoreCameraClearFlags(),
            started: null,
            hooked: null,
            cookies: null,
            transparent: false,
            zoom: false,
            ua: ua,
            radius: 0,
            androidForceDarkMode: 1);

        var wait = 0;
        while (!webViewObject.IsInitialized() && wait < 600)
        {
            wait++;
            yield return null;
        }

        if (!webViewObject.IsInitialized())
        {
            Debug.LogError("[WebView] Timed out waiting for IsInitialized().");
            yield break;
        }

#if UNITY_ANDROID && !UNITY_EDITOR
        webViewObject.SetMixedContentMode(0);
        webViewObject.SetTextZoom(100);
#endif
        webViewObject.SetMargins(0, 0, 0, 0);
        webViewObject.SetVisibility(true);

        var fileUrl = "file://" + dstIndex.Replace("\\", "/").Replace(" ", "%20");
        var sep = fileUrl.Contains("?") ? "&" : "?";
        webViewObject.LoadURL(fileUrl + sep + "unity-webview=1");
    }

    void RestoreCameraClearFlags()
    {
        if (camerasCleared == null || previousClearFlags == null || previousBgColors == null)
            return;
        for (var i = 0; i < camerasCleared.Length; i++)
        {
            if (camerasCleared[i] == null)
                continue;
            camerasCleared[i].clearFlags = previousClearFlags[i];
            camerasCleared[i].backgroundColor = previousBgColors[i];
        }

        camerasCleared = null;
        previousClearFlags = null;
        previousBgColors = null;
    }

    void OnApplicationPause(bool paused)
    {
        if (paused || webViewObject == null)
            return;
        StartCoroutine(RefreshWebViewAfterResume());
    }

    IEnumerator RefreshWebViewAfterResume()
    {
        yield return new WaitForSecondsRealtime(0.25f);
        if (webViewObject == null)
            yield break;
        webViewObject.SetMargins(0, 0, 0, 0);
        webViewObject.SetVisibility(webViewObject.GetVisibility());
    }

    void OnDestroy()
    {
        RestoreCameraClearFlags();
        if (webViewObject != null)
            Destroy(webViewObject.gameObject);
    }
#endif
}
