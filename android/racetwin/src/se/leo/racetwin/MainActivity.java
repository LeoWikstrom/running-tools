package se.leo.racetwin;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.GeolocationPermissions;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * RaceTwin is the bundled web build in a WebView — nothing native beyond
 * serving the assets and relaying the geolocation permission. The tour apps'
 * MainActivity is the pattern; this is its generic subset.
 */
public class MainActivity extends Activity {

    /**
     * The web build is served from a pretend https origin, not file:// —
     * Vite emits ES-module scripts and crossorigin stylesheets, which the
     * opaque file:// origin refuses to load.
     */
    private static final String HOST = "racetwin.local";
    private static final String BASE = "https://" + HOST + "/index.html";

    private static final int REQ_GEO_PERMISSION = 12;
    private static final int REQ_FILE_CHOOSER = 13;

    private WebView web;
    private String pendingGeoOrigin;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private ValueCallback<Uri[]> pendingFileCallback;

    private static String mimeFor(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js")) return "text/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".json") || path.endsWith(".webmanifest")) return "application/json";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".png")) return "image/png";
        if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
        if (path.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);

        web = new WebView(this);
        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setAllowFileAccess(true);
        applyDarkMode(ws);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                // External links open in the browser; navigating the WebView
                // away would reload the app and lose the session.
                if (HOST.equals(url.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (Exception ignored) {
                    // No browser installed: swallow the tap rather than navigate.
                }
                return true;
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (!HOST.equals(url.getHost())) return null;
                String path = url.getPath();
                if (path == null || path.equals("/")) path = "/index.html";
                // The service worker's own fetches bypass this interception,
                // so a registered worker would strand the app against a host
                // that does not exist. Refusing sw.js keeps us in charge.
                if (path.equals("/sw.js")) {
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not found",
                            java.util.Collections.<String, String>emptyMap(),
                            new ByteArrayInputStream(new byte[0]));
                }
                try {
                    InputStream in = getAssets().open("www" + path);
                    return new WebResourceResponse(mimeFor(path), "utf-8", in);
                } catch (IOException e) {
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not found",
                            java.util.Collections.<String, String>emptyMap(),
                            new ByteArrayInputStream(new byte[0]));
                }
            }
        });
        ws.setGeolocationEnabled(true);
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin,
                    GeolocationPermissions.Callback callback) {
                if (checkSelfPermission("android.permission.ACCESS_FINE_LOCATION")
                        == PackageManager.PERMISSION_GRANTED) {
                    callback.invoke(origin, true, false);
                    return;
                }
                pendingGeoOrigin = origin;
                pendingGeoCallback = callback;
                requestPermissions(
                        new String[] {"android.permission.ACCESS_FINE_LOCATION"},
                        REQ_GEO_PERMISSION);
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                if (pendingFileCallback != null) pendingFileCallback.onReceiveValue(null);
                pendingFileCallback = callback;
                // The page's accept list (.gpx) is deliberately not forwarded:
                // GPX has no reliably registered MIME type, so a typed chooser
                // greys out the very files the input is for.
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                try {
                    startActivityForResult(intent, REQ_FILE_CHOOSER);
                } catch (Exception e) {
                    pendingFileCallback = null;
                    return false;
                }
                return true;
            }
        });
        setContentView(web);
        web.loadUrl(BASE);
    }

    @Override
    protected void onActivityResult(int req, int result, Intent data) {
        super.onActivityResult(req, result, data);
        if (req != REQ_FILE_CHOOSER || pendingFileCallback == null) return;
        Uri[] uris = null;
        if (result == RESULT_OK && data != null && data.getData() != null) {
            uris = new Uri[] {data.getData()};
        }
        pendingFileCallback.onReceiveValue(uris);
        pendingFileCallback = null;
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] results) {
        super.onRequestPermissionsResult(req, perms, results);
        if (req != REQ_GEO_PERMISSION) return;
        boolean fineLocation = false;
        for (int i = 0; i < perms.length; i++) {
            if ("android.permission.ACCESS_FINE_LOCATION".equals(perms[i])
                    && results[i] == PackageManager.PERMISSION_GRANTED) {
                fineLocation = true;
            }
        }
        if (pendingGeoCallback != null) {
            pendingGeoCallback.invoke(pendingGeoOrigin, fineLocation, false);
            pendingGeoCallback = null;
            pendingGeoOrigin = null;
        }
    }

    @SuppressWarnings("deprecation")
    private void applyDarkMode(WebSettings ws) {
        boolean night = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        if (Build.VERSION.SDK_INT >= 33) {
            ws.setAlgorithmicDarkeningAllowed(false);
        } else if (Build.VERSION.SDK_INT >= 29) {
            ws.setForceDark(night ? WebSettings.FORCE_DARK_ON : WebSettings.FORCE_DARK_OFF);
        }
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }
}
