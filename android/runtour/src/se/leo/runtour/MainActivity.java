package se.leo.runtour;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.PowerManager;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The preparation app is the bundled web build in a WebView; this activity
 * adds what a page cannot do itself: the tour store, system text-to-speech to
 * files, un-CORSed fetches and tour.json import via open-with/share-to.
 */
public class MainActivity extends Activity {

    /**
     * The web build is served from a pretend https origin, not file:// —
     * Vite emits ES-module scripts and crossorigin stylesheets, which the
     * opaque file:// origin refuses to load (the page came up bare HTML).
     * shouldInterceptRequest answers for this host from the bundled assets.
     */
    private static final String HOST = "runtour.local";
    private static final String BASE = "https://" + HOST + "/index.html";

    /**
     * The page may only fetch from the services the web app itself talks to;
     * a crafted tour.json must not turn the bridge's fetch methods into an
     * open proxy (exfiltration, local-network probing).
     */
    private static final String[] ALLOWED_HOSTS = {
            "wikipedia.org", "wikimedia.org", "wikidata.org", "openstreetmap.org",
            "overpass-api.de", "overpass.kumi.systems", "overpass.private.coffee",
            "maps.mail.ru",
    };

    private static boolean isAllowedUrl(String url) {
        try {
            URI u = new URI(url);
            if (!"https".equals(u.getScheme())) return false;
            if (u.getUserInfo() != null) return false;
            String host = u.getHost();
            if (host == null) return false;
            host = host.toLowerCase(Locale.ROOT);
            for (String allowed : ALLOWED_HOSTS) {
                if (host.equals(allowed) || host.endsWith("." + allowed)) return true;
            }
            return false;
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean isSafeName(String name) {
        return name != null && !name.isEmpty()
                && !name.contains("/") && !name.contains("\\") && !name.contains("..");
    }

    private WebView web;
    private TextToSpeech tts;
    private final CountDownLatch ttsReady = new CountDownLatch(1);
    private int ttsStatus = TextToSpeech.ERROR;
    /** utteranceId -> JS callback id, for synthesis completion. */
    private final Map<String, Integer> utterances = new ConcurrentHashMap<>();
    private final ExecutorService executor = Executors.newFixedThreadPool(2);
    private MediaPlayer player;

    private static final int REQ_RUN_PERMISSIONS = 11;
    private static final int REQ_GEO_PERMISSION = 12;
    private static final int REQ_DOWNLOAD_PERMISSION = 13;

    /** Bound for the web run UI; the binding keeps the finished service's
        summary alive until the page has read it. */
    private volatile RunService runService;
    /** Last download status, for showing the notice right after a grant. */
    private volatile String pendingDownloadText;
    private String pendingRunTourId;
    private String pendingGeoOrigin;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private final ServiceConnection runConnection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            runService = ((RunService.LocalBinder) binder).service();
        }

        @Override public void onServiceDisconnected(ComponentName name) {
            runService = null;
        }
    };

    private static String mimeFor(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js")) return "text/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".json")) return "application/json";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".png")) return "image/png";
        if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
        if (path.endsWith(".gif")) return "image/gif";
        if (path.endsWith(".webp")) return "image/webp";
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
                // Wikipedia and friends open in the browser; navigating the
                // WebView away would reload the app and lose the tour.
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
                // /tours/<id>/<file> serves prefetched images (and anything
                // else filed with a tour) from the phone, for offline runs.
                if (path.startsWith("/tours/")) {
                    String[] parts = path.split("/");
                    if (parts.length == 4) {
                        File stored = new File(Tours.dir(MainActivity.this,
                                Tours.sanitize(parts[2])), Tours.sanitize(parts[3]));
                        try {
                            return new WebResourceResponse(mimeFor(path), null,
                                    new java.io.FileInputStream(stored));
                        } catch (IOException e) {
                            // Falls through to the 404 below.
                        }
                    }
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
        });
        web.addJavascriptInterface(new Bridge(), "RunTour");
        setContentView(web);
        web.loadUrl(BASE);
        bindService(new Intent(this, RunService.class), runConnection, Context.BIND_AUTO_CREATE);

        tts = new TextToSpeech(this, status -> {
            ttsStatus = status;
            ttsReady.countDown();
        });
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) {}

            @Override public void onDone(String id) {
                Integer callback = utterances.remove(id);
                if (callback != null) resolveJs(callback, true, "done");
            }

            @Override public void onError(String id) {
                Integer callback = utterances.remove(id);
                if (callback != null) resolveJs(callback, false, "text-to-speech failed");
            }

            // tts.stop() reports here, not onDone — without this the page's
            // promise for the interrupted clip would never settle.
            @Override public void onStop(String id, boolean interrupted) {
                Integer callback = utterances.remove(id);
                if (callback != null) resolveJs(callback, true, "stopped");
            }
        });

        handleIncoming(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIncoming(intent);
    }

    /** A tour.json opened with or shared to the app lands on the shelf. */
    private void handleIncoming(Intent intent) {
        if (intent == null) return;
        Uri uri = null;
        if (Intent.ACTION_VIEW.equals(intent.getAction())) uri = intent.getData();
        else if (Intent.ACTION_SEND.equals(intent.getAction())) uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (uri == null) return;
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            String id = Tours.save(this, Tours.readStream(in));
            Toast.makeText(this, "Tour imported: " + id, Toast.LENGTH_SHORT).show();
            web.reload();
        } catch (Exception e) {
            Toast.makeText(this, "Not a tour file: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    /** Hand a result back to the page's promise registry. */
    private void resolveJs(int callbackId, boolean ok, String payload) {
        runOnUiThread(() -> web.evaluateJavascript(
                "window.__rtResolve(" + callbackId + "," + ok + "," + JSONObject.quote(payload) + ")", null));
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

    @Override
    protected void onDestroy() {
        unbindService(runConnection);
        if (tts != null) tts.shutdown();
        if (player != null) player.release();
        executor.shutdownNow();
        super.onDestroy();
    }

    /** Start the run once the permissions are in place (UI thread). */
    private void beginRun(String tourId) {
        if (checkSelfPermission("android.permission.ACCESS_FINE_LOCATION")
                != PackageManager.PERMISSION_GRANTED
                || (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                != PackageManager.PERMISSION_GRANTED)) {
            pendingRunTourId = tourId;
            requestPermissions(new String[] {
                    "android.permission.ACCESS_FINE_LOCATION",
                    "android.permission.POST_NOTIFICATIONS",
            }, REQ_RUN_PERMISSIONS);
            return;
        }
        askBatteryExemption();
        startForegroundService(new Intent(this, RunService.class)
                .setAction(RunService.ACTION_START)
                .putExtra(RunService.EXTRA_TOUR_ID, tourId));
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] results) {
        super.onRequestPermissionsResult(req, perms, results);
        boolean fineLocation = checkSelfPermission("android.permission.ACCESS_FINE_LOCATION")
                == PackageManager.PERMISSION_GRANTED;
        if (req == REQ_GEO_PERMISSION) {
            if (pendingGeoCallback != null) {
                pendingGeoCallback.invoke(pendingGeoOrigin, fineLocation, false);
                pendingGeoCallback = null;
                pendingGeoOrigin = null;
            }
            return;
        }
        if (req == REQ_DOWNLOAD_PERMISSION) {
            // First download: the grant arrives mid-download, and the next
            // status update may be many seconds out — show the notice now.
            String text = pendingDownloadText;
            if (text != null && !text.isEmpty()) {
                try {
                    startForegroundService(new Intent(this, DownloadService.class)
                            .setAction(DownloadService.ACTION_STATUS)
                            .putExtra(DownloadService.EXTRA_TEXT, text));
                } catch (Exception ignored) {
                    // Purely cosmetic; the download is running regardless.
                }
            }
            return;
        }
        if (req != REQ_RUN_PERMISSIONS) return;
        String tourId = pendingRunTourId;
        pendingRunTourId = null;
        if (!fineLocation) {
            Toast.makeText(this, "The run player needs GPS to trigger the audio.",
                    Toast.LENGTH_LONG).show();
            return;
        }
        if (tourId != null) beginRun(tourId);
    }

    /** Ask for POST_NOTIFICATIONS when a download begins, so its progress shows. */
    private void askNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return;
        runOnUiThread(() -> {
            if (checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" },
                        REQ_DOWNLOAD_PERMISSION);
            }
        });
    }

    /** One line of why, then the system dialog; some phones kill plain services. */
    private void askBatteryExemption() {
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm.isIgnoringBatteryOptimizations(getPackageName())) return;
        Toast.makeText(this,
                "Allow " + getApplicationInfo().loadLabel(getPackageManager())
                        + " to ignore battery optimisation so audio keeps playing with the screen off.",
                Toast.LENGTH_LONG).show();
        try {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getPackageName())));
        } catch (Exception ignored) {
            // Some builds hide the dialog; the service still runs on most.
        }
    }

    /** window.RunTour — everything here runs off the UI thread unless noted. */
    private final class Bridge {

        @JavascriptInterface
        public String listTours() {
            return Tours.list(MainActivity.this);
        }

        @JavascriptInterface
        public String getTour(String id) {
            try {
                return Tours.read(MainActivity.this, id);
            } catch (Exception e) {
                return "";
            }
        }

        /** Returns the tour id, or "" when the JSON is not a tour. */
        @JavascriptInterface
        public String saveTour(String json) {
            try {
                return Tours.save(MainActivity.this, json);
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public void deleteTour(String id) {
            Tours.delete(MainActivity.this, id);
        }

        /**
         * Area-download notification: non-empty text starts/updates the
         * dataSync foreground service that keeps a minimised app
         * downloading; empty text takes it down. Started while the page is
         * visible, so the foreground-start restriction never applies.
         */
        @JavascriptInterface
        public void downloadStatus(String text) {
            pendingDownloadText = text == null ? "" : text;
            Intent intent = new Intent(MainActivity.this, DownloadService.class)
                    .setAction(DownloadService.ACTION_STATUS)
                    .putExtra(DownloadService.EXTRA_TEXT, text == null ? "" : text);
            try {
                if (text != null && !text.isEmpty()) {
                    askNotificationPermission();
                    startForegroundService(intent);
                } else {
                    startService(intent);
                }
            } catch (Exception ignored) {
                // A refused service start must never break the download itself.
            }
        }

        /** A dismissible "finished" notice once the ongoing one is taken down. */
        @JavascriptInterface
        public void downloadDone(String text) {
            if (text == null || text.isEmpty()) return;
            try {
                DownloadService.postFinished(MainActivity.this, text);
            } catch (Exception ignored) {
                // Purely informational; never break the page over it.
            }
        }

        /**
         * System TTS into files/tours/&lt;id&gt;/&lt;filename&gt;; resolves the JS
         * callback when the file is written. Queued inside TextToSpeech, so
         * sequential calls are fine.
         */
        @JavascriptInterface
        public void synthesize(String tourId, String filename, String text, String lang, int callbackId) {
            executor.execute(() -> {
                try {
                    ttsReady.await();
                    if (ttsStatus != TextToSpeech.SUCCESS) {
                        resolveJs(callbackId, false, "text-to-speech unavailable");
                        return;
                    }
                    int has = tts.setLanguage(Locale.forLanguageTag(lang));
                    if (has == TextToSpeech.LANG_MISSING_DATA || has == TextToSpeech.LANG_NOT_SUPPORTED) {
                        resolveJs(callbackId, false, "no voice installed for " + lang);
                        return;
                    }
                    File dir = Tours.dir(MainActivity.this, tourId);
                    dir.mkdirs();
                    File out = new File(dir, Tours.sanitize(filename));
                    String utteranceId = "u" + callbackId;
                    utterances.put(utteranceId, callbackId);
                    Bundle params = new Bundle();
                    int queued = tts.synthesizeToFile(text, params, out, utteranceId);
                    if (queued != TextToSpeech.SUCCESS) {
                        utterances.remove(utteranceId);
                        resolveJs(callbackId, false, "could not queue synthesis");
                    }
                } catch (Exception e) {
                    resolveJs(callbackId, false, String.valueOf(e.getMessage()));
                }
            });
        }

        /** Speak aloud right now — the editor's preview; the WebView has no
            Web Speech API, so the page borrows the phone's voice. */
        @JavascriptInterface
        public void speak(String text, String lang, int callbackId) {
            executor.execute(() -> {
                try {
                    ttsReady.await();
                    if (ttsStatus != TextToSpeech.SUCCESS) {
                        resolveJs(callbackId, false, "text-to-speech unavailable");
                        return;
                    }
                    int has = tts.setLanguage(Locale.forLanguageTag(lang));
                    if (has == TextToSpeech.LANG_MISSING_DATA || has == TextToSpeech.LANG_NOT_SUPPORTED) {
                        resolveJs(callbackId, false, "no voice installed for " + lang);
                        return;
                    }
                    String utteranceId = "u" + callbackId;
                    utterances.put(utteranceId, callbackId);
                    int queued = tts.speak(text, TextToSpeech.QUEUE_FLUSH, new Bundle(), utteranceId);
                    if (queued != TextToSpeech.SUCCESS) {
                        utterances.remove(utteranceId);
                        resolveJs(callbackId, false, "could not queue speech");
                    }
                } catch (Exception e) {
                    resolveJs(callbackId, false, String.valueOf(e.getMessage()));
                }
            });
        }

        @JavascriptInterface
        public void stopSpeaking() {
            runOnUiThread(() -> {
                try {
                    tts.stop();
                } catch (Exception ignored) {
                    // No speech in flight.
                }
            });
        }

        /** GET a URL into the tour's directory — historical pictures offline. */
        @JavascriptInterface
        public void downloadTourFile(String tourId, String filename, String url, int callbackId) {
            if (!isAllowedUrl(url)) {
                resolveJs(callbackId, false, "blocked url");
                return;
            }
            if (!isSafeName(tourId) || !isSafeName(filename)) {
                resolveJs(callbackId, false, "blocked filename");
                return;
            }
            executor.execute(() -> {
                HttpURLConnection conn = null;
                try {
                    conn = (HttpURLConnection) new URL(url).openConnection();
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(30000);
                    conn.setRequestProperty("User-Agent", "RunTour (Android)");
                    File dir = Tours.dir(MainActivity.this, tourId);
                    dir.mkdirs();
                    File out = new File(dir, Tours.sanitize(filename));
                    String root = Tours.root(MainActivity.this).getCanonicalPath();
                    if (!out.getCanonicalPath().startsWith(root + File.separator)) {
                        resolveJs(callbackId, false, "blocked filename");
                        return;
                    }
                    try (InputStream in = conn.getInputStream();
                            java.io.FileOutputStream file = new java.io.FileOutputStream(out)) {
                        byte[] buf = new byte[8192];
                        int n;
                        while ((n = in.read(buf)) > 0) file.write(buf, 0, n);
                    }
                    resolveJs(callbackId, true, "");
                } catch (Exception e) {
                    resolveJs(callbackId, false, String.valueOf(e.getMessage()));
                } finally {
                    if (conn != null) conn.disconnect();
                }
            });
        }

        /** GET a URL without the page's CORS limits (for official sites later). */
        @JavascriptInterface
        public void fetchText(String url, int callbackId) {
            if (!isAllowedUrl(url)) {
                resolveJs(callbackId, false, "blocked url");
                return;
            }
            executor.execute(() -> {
                HttpURLConnection conn = null;
                try {
                    conn = (HttpURLConnection) new URL(url).openConnection();
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(30000);
                    conn.setRequestProperty("User-Agent", "RunTour (Android)");
                    try (InputStream in = conn.getInputStream()) {
                        resolveJs(callbackId, true, Tours.readStream(in));
                    }
                } catch (Exception e) {
                    resolveJs(callbackId, false, String.valueOf(e.getMessage()));
                } finally {
                    if (conn != null) conn.disconnect();
                }
            });
        }

        /** Preview one clip from the shelf. Returns false when the file is missing. */
        @JavascriptInterface
        public boolean playFile(String tourId, String filename) {
            File file = new File(Tours.dir(MainActivity.this, tourId), Tours.sanitize(filename));
            if (!file.isFile()) return false;
            runOnUiThread(() -> {
                try {
                    if (player != null) player.release();
                    player = new MediaPlayer();
                    player.setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build());
                    player.setDataSource(file.getAbsolutePath());
                    player.setOnCompletionListener((mp) -> web.evaluateJavascript(
                            "window.__rtPlaybackEnded && window.__rtPlaybackEnded()", null));
                    player.prepare();
                    player.start();
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Cannot play: " + e.getMessage(), Toast.LENGTH_SHORT).show();
                }
            });
            return true;
        }

        /** Starts the GPS run service; the page's poll sees `started` flip. */
        @JavascriptInterface
        public void startRun(String tourId) {
            runOnUiThread(() -> beginRun(tourId));
        }

        /** The run service's state for the page's once-a-second poll. */
        @JavascriptInterface
        public String runState() {
            RunService service = runService;
            try {
                JSONObject out = new JSONObject();
                if (service == null || !service.isStarted()) {
                    out.put("started", false);
                    return out.toString();
                }
                out.put("started", true);
                out.put("paused", service.isPaused());
                out.put("finished", service.isFinished());
                out.put("tourId", service.tourId());
                out.put("tourName", service.tourName());
                out.put("dNow", service.dNow());
                out.put("tourDistance", service.tourDistance());
                out.put("elapsedSeconds", service.elapsedSeconds());
                out.put("offCourse", service.offCourse());
                String label = service.nextPlaceLabel();
                if (label == null) {
                    out.put("nextPlaceName", JSONObject.NULL);
                    out.put("nextPlaceRemainingM", JSONObject.NULL);
                } else {
                    int cut = label.lastIndexOf('|');
                    out.put("nextPlaceName", label.substring(0, cut));
                    out.put("nextPlaceRemainingM", Long.parseLong(label.substring(cut + 1)));
                }
                String playing = service.playingPlaceId();
                out.put("playingPlaceId", playing == null ? JSONObject.NULL : playing);
                double lat = service.lastLat();
                out.put("lat", Double.isNaN(lat) ? JSONObject.NULL : lat);
                double lon = service.lastLon();
                out.put("lon", Double.isNaN(lon) ? JSONObject.NULL : lon);
                org.json.JSONArray summary = new org.json.JSONArray();
                for (String line : service.summaryLines()) {
                    int tab = line.indexOf('\t');
                    JSONObject entry = new JSONObject();
                    entry.put("outcome", line.substring(0, tab));
                    entry.put("name", line.substring(tab + 1));
                    summary.put(entry);
                }
                out.put("summary", summary);
                return out.toString();
            } catch (Exception e) {
                return "{\"started\":false}";
            }
        }

        /** pause/skip/repeat/finish go to the service; reset readies a new run. */
        @JavascriptInterface
        public void runAction(String action) {
            if ("reset".equals(action)) {
                RunService service = runService;
                if (service != null) runOnUiThread(service::reset);
                return;
            }
            String intentAction =
                    "pause".equals(action) ? RunService.ACTION_PAUSE
                    : "skip".equals(action) ? RunService.ACTION_SKIP
                    : "repeat".equals(action) ? RunService.ACTION_REPEAT
                    : "finish".equals(action) ? RunService.ACTION_FINISH
                    : null;
            if (intentAction == null) return;
            startService(new Intent(MainActivity.this, RunService.class).setAction(intentAction));
        }

        @JavascriptInterface
        public void stopPlayback() {
            runOnUiThread(() -> {
                if (player != null) {
                    player.release();
                    player = null;
                }
            });
        }
    }
}
