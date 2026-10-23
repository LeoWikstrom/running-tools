package se.leo.runtour;

import android.app.Activity;
import android.content.Intent;
import android.content.res.Configuration;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.io.InputStream;
import java.net.HttpURLConnection;
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

    private static final String BASE = "file:///android_asset/www/index.html";

    private WebView web;
    private TextToSpeech tts;
    private final CountDownLatch ttsReady = new CountDownLatch(1);
    private int ttsStatus = TextToSpeech.ERROR;
    /** utteranceId -> JS callback id, for synthesis completion. */
    private final Map<String, Integer> utterances = new ConcurrentHashMap<>();
    private final ExecutorService executor = Executors.newFixedThreadPool(2);
    private MediaPlayer player;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);

        web = new WebView(this);
        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setAllowFileAccess(true);
        applyDarkMode(ws);
        web.setWebViewClient(new WebViewClient());
        web.addJavascriptInterface(new Bridge(), "RunTour");
        setContentView(web);
        web.loadUrl(BASE);

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
        if (tts != null) tts.shutdown();
        if (player != null) player.release();
        executor.shutdownNow();
        super.onDestroy();
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

        /** GET a URL without the page's CORS limits (for official sites later). */
        @JavascriptInterface
        public void fetchText(String url, int callbackId) {
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
                    player.prepare();
                    player.start();
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Cannot play: " + e.getMessage(), Toast.LENGTH_SHORT).show();
                }
            });
            return true;
        }

        /** Opens the native run screen, which starts the GPS service. */
        @JavascriptInterface
        public void startRun(String tourId) {
            Intent intent = new Intent(MainActivity.this, RunActivity.class)
                    .putExtra(RunActivity.EXTRA_TOUR_ID, tourId);
            startActivity(intent);
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
