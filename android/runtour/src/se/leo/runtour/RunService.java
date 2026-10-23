package se.leo.runtour;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.ToneGenerator;
import android.os.Binder;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * The player during the run: GPS once a second, the runtime decides what to
 * play, audio ducks whatever else is playing. Lives as a foreground service
 * so the screen can be off and the WebView closed.
 */
public class RunService extends Service implements LocationListener {

    public static final String ACTION_START = "se.leo.runtour.START";
    public static final String ACTION_PAUSE = "se.leo.runtour.PAUSE";
    public static final String ACTION_SKIP = "se.leo.runtour.SKIP";
    public static final String ACTION_REPEAT = "se.leo.runtour.REPEAT";
    public static final String ACTION_FINISH = "se.leo.runtour.FINISH";
    public static final String EXTRA_TOUR_ID = "tourId";

    private static final String CHANNEL = "run";
    private static final int NOTIFICATION_ID = 1;

    public final class LocalBinder extends Binder {
        RunService service() {
            return RunService.this;
        }
    }

    private final IBinder binder = new LocalBinder();
    private final Handler handler = new Handler(Looper.getMainLooper());

    private static final class TourPlace {
        String id;
        String name;
        String text;
        String audio;
        double triggerD;
        double d;
    }

    private String tourId;
    private String tourName = "";
    private double tourDistance;
    private final List<TourPlace> places = new ArrayList<>();
    private RunRuntime runtime;

    private LocationManager locations;
    private PowerManager.WakeLock wakeLock;
    private AudioManager audio;
    private AudioFocusRequest focus;
    private MediaPlayer player;
    private TextToSpeech tts;
    private boolean ttsOk = false;
    private String playingId;
    private String lastPlayedId;
    private boolean paused = false;
    private boolean finished = false;
    private long startedAt;

    @Override
    public void onCreate() {
        super.onCreate();
        locations = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        audio = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "runtour:run");
        tts = new TextToSpeech(this, status -> ttsOk = status == TextToSpeech.SUCCESS);
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) {}

            @Override public void onDone(String id) {
                handler.post(RunService.this::clipEnded);
            }

            @Override public void onError(String id) {
                handler.post(RunService.this::clipEnded);
            }
        });
    }

    @Override
    public IBinder onBind(Intent intent) {
        return binder;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_START.equals(action)) {
            start(intent.getStringExtra(EXTRA_TOUR_ID));
        } else if (ACTION_PAUSE.equals(action)) {
            setPaused(!paused);
        } else if (ACTION_SKIP.equals(action)) {
            skip();
        } else if (ACTION_REPEAT.equals(action)) {
            repeat();
        } else if (ACTION_FINISH.equals(action)) {
            finishRun();
        }
        return START_NOT_STICKY;
    }

    private void start(String id) {
        if (runtime != null) return; // already running
        try {
            JSONObject tour = new JSONObject(Tours.read(this, id));
            tourId = id;
            tourName = tour.optString("name", id);
            tourDistance = tour.getJSONObject("route").optDouble("distance", 0);
            JSONArray route = tour.getJSONObject("route").getJSONArray("points");
            double[] lats = new double[route.length()];
            double[] lons = new double[route.length()];
            for (int i = 0; i < route.length(); i++) {
                JSONArray p = route.getJSONArray(i);
                lats[i] = p.getDouble(0);
                lons[i] = p.getDouble(1);
            }
            JSONArray placesJson = tour.getJSONArray("places");
            List<RunRuntime.Place> rtPlaces = new ArrayList<>();
            for (int i = 0; i < placesJson.length(); i++) {
                JSONObject p = placesJson.getJSONObject(i);
                TourPlace tp = new TourPlace();
                tp.id = p.getString("id");
                tp.name = p.getString("name");
                tp.text = p.optString("text", "");
                tp.audio = p.optString("audio", null);
                tp.triggerD = p.getDouble("triggerD");
                tp.d = p.getDouble("d");
                places.add(tp);
                rtPlaces.add(new RunRuntime.Place(tp.id, tp.triggerD));
            }
            runtime = new RunRuntime(lats, lons,
                    rtPlaces.toArray(new RunRuntime.Place[0]), RunRuntime.Settings.defaults());
        } catch (Exception e) {
            stopSelf();
            return;
        }
        startedAt = SystemClock.elapsedRealtime();
        createChannel();
        startForeground(NOTIFICATION_ID, buildNotification("Waiting for GPS…"));
        wakeLock.acquire(4 * 60 * 60 * 1000L);
        requestLocation();
    }

    @SuppressWarnings("MissingPermission")
    private void requestLocation() {
        try {
            locations.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000, 0, this);
        } catch (SecurityException e) {
            stopSelf();
        }
    }

    @Override
    public void onLocationChanged(Location location) {
        if (paused || finished || runtime == null) return;
        double t = SystemClock.elapsedRealtime() / 1000.0;
        runtime.update(t, location.getLatitude(), location.getLongitude(), this::onRuntimeEvent);
        updateNotification();
    }

    @Override public void onProviderEnabled(String provider) {}
    @Override public void onProviderDisabled(String provider) {}
    @SuppressWarnings("deprecation")
    @Override public void onStatusChanged(String provider, int status, Bundle extras) {}

    private void onRuntimeEvent(String event, String placeId) {
        if ("play".equals(event)) {
            playClip(placeId);
        } else if ("offCourse".equals(event)) {
            beep();
        }
        // drop and onCourse pass silently; the summary tells the tale.
    }

    private TourPlace place(String id) {
        for (TourPlace p : places) if (p.id.equals(id)) return p;
        return null;
    }

    private void playClip(String id) {
        TourPlace p = place(id);
        if (p == null) {
            clipEnded();
            return;
        }
        playingId = id;
        lastPlayedId = id;
        requestFocus();
        chimeThen(() -> {
            File file = p.audio == null ? null : new File(Tours.dir(this, tourId), p.audio);
            if (file != null && file.isFile()) {
                try {
                    if (player != null) player.release();
                    player = new MediaPlayer();
                    player.setAudioAttributes(speechAttributes());
                    player.setDataSource(file.getAbsolutePath());
                    player.setOnCompletionListener(mp -> clipEnded());
                    player.prepare();
                    player.start();
                    return;
                } catch (Exception ignored) {
                    // fall through to TTS
                }
            }
            if (ttsOk && p.text != null && !p.text.isEmpty()) {
                Bundle params = new Bundle();
                params.putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, AudioManager.STREAM_MUSIC);
                tts.speak(p.text, TextToSpeech.QUEUE_FLUSH, params, "clip-" + id);
            } else {
                clipEnded();
            }
        });
    }

    /** A short chime announces the voice, then the clip follows. */
    private void chimeThen(Runnable then) {
        try {
            ToneGenerator tone = new ToneGenerator(AudioManager.STREAM_MUSIC, 80);
            tone.startTone(ToneGenerator.TONE_PROP_BEEP2, 250);
            handler.postDelayed(() -> {
                tone.release();
                then.run();
            }, 350);
        } catch (Exception e) {
            then.run();
        }
    }

    private void beep() {
        try {
            ToneGenerator tone = new ToneGenerator(AudioManager.STREAM_MUSIC, 80);
            tone.startTone(ToneGenerator.TONE_SUP_ERROR, 300);
            handler.postDelayed(tone::release, 400);
        } catch (Exception ignored) {
            // A missing beep is not worth a crash.
        }
    }

    private void clipEnded() {
        playingId = null;
        abandonFocus();
        if (runtime != null) runtime.clipEnded(this::onRuntimeEvent);
        updateNotification();
    }

    private AudioAttributes speechAttributes() {
        return new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build();
    }

    /** Music ducks while the narration speaks and comes back afterwards. */
    private void requestFocus() {
        if (focus == null) {
            focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                    .setAudioAttributes(speechAttributes())
                    .build();
        }
        audio.requestAudioFocus(focus);
    }

    private void abandonFocus() {
        if (focus != null) audio.abandonAudioFocusRequest(focus);
    }

    // Controls, shared by the notification and the run screen.

    public void setPaused(boolean value) {
        paused = value;
        if (paused) {
            locations.removeUpdates(this);
            stopClip();
        } else {
            requestLocation();
        }
        updateNotification();
    }

    public void skip() {
        if (playingId != null) stopClip();
    }

    public void repeat() {
        if (lastPlayedId != null && playingId == null) {
            // Replay outside the runtime: outcomes stay as they are.
            TourPlace p = place(lastPlayedId);
            if (p == null) return;
            playingId = lastPlayedId;
            requestFocus();
            File file = p.audio == null ? null : new File(Tours.dir(this, tourId), p.audio);
            if (file != null && file.isFile()) {
                try {
                    if (player != null) player.release();
                    player = new MediaPlayer();
                    player.setAudioAttributes(speechAttributes());
                    player.setDataSource(file.getAbsolutePath());
                    player.setOnCompletionListener(mp -> {
                        playingId = null;
                        abandonFocus();
                    });
                    player.prepare();
                    player.start();
                } catch (Exception ignored) {
                    playingId = null;
                }
            } else if (ttsOk && !p.text.isEmpty()) {
                tts.speak(p.text, TextToSpeech.QUEUE_FLUSH, new Bundle(), "repeat");
            }
        }
    }

    private void stopClip() {
        if (player != null) {
            player.release();
            player = null;
        }
        if (tts != null) tts.stop();
        if (playingId != null) clipEnded();
    }

    public void finishRun() {
        finished = true;
        locations.removeUpdates(this);
        stopClip();
        if (wakeLock.isHeld()) wakeLock.release();
        stopForeground(STOP_FOREGROUND_REMOVE);
        // The bound run screen reads the summary, then unbinds; then we die.
        stopSelf();
    }

    // State for the run screen's once-a-second poll.

    public boolean isStarted() {
        return runtime != null;
    }

    public boolean isPaused() {
        return paused;
    }

    public boolean isFinished() {
        return finished;
    }

    public String tourName() {
        return tourName;
    }

    public double dNow() {
        return runtime == null ? 0 : runtime.dNow();
    }

    public double tourDistance() {
        return tourDistance;
    }

    public boolean offCourse() {
        return runtime != null && runtime.isOffCourse();
    }

    public long elapsedSeconds() {
        return (SystemClock.elapsedRealtime() - startedAt) / 1000;
    }

    /** "name|metres" of the next pending place, or null. */
    public String nextPlaceLabel() {
        if (runtime == null) return null;
        RunRuntime.Place next = runtime.nextPlace();
        if (next == null) return null;
        TourPlace p = place(next.id);
        long metres = Math.round(Math.max(0, next.triggerD - runtime.dNow()));
        return (p == null ? next.id : p.name) + "|" + metres;
    }

    /** One line per place: outcome<TAB>name. */
    public List<String> summaryLines() {
        List<String> out = new ArrayList<>();
        if (runtime == null) return out;
        for (String[] entry : runtime.summary()) {
            TourPlace p = place(entry[0]);
            out.add(entry[1] + "\t" + (p == null ? entry[0] : p.name));
        }
        return out;
    }

    // Notification

    private void createChannel() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(
                new NotificationChannel(CHANNEL, "Run", NotificationManager.IMPORTANCE_LOW));
    }

    private PendingIntent serviceAction(String action) {
        Intent intent = new Intent(this, RunService.class).setAction(action);
        return PendingIntent.getService(this, action.hashCode(), intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification buildNotification(String text) {
        Intent open = new Intent(this, RunActivity.class);
        PendingIntent content = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_run)
                .setContentTitle(tourName)
                .setContentText(text)
                .setContentIntent(content)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .addAction(new Notification.Action.Builder(null,
                        paused ? "Resume" : "Pause", serviceAction(ACTION_PAUSE)).build())
                .addAction(new Notification.Action.Builder(null,
                        "Skip", serviceAction(ACTION_SKIP)).build())
                .addAction(new Notification.Action.Builder(null,
                        "Repeat", serviceAction(ACTION_REPEAT)).build())
                .addAction(new Notification.Action.Builder(null,
                        "Finish", serviceAction(ACTION_FINISH)).build());
        return b.build();
    }

    private void updateNotification() {
        if (finished) return;
        String label = nextPlaceLabel();
        String text;
        if (paused) text = "Paused";
        else if (offCourse()) text = "Off course";
        else if (label == null) text = String.format("%.1f km", dNow() / 1000);
        else {
            String[] parts = label.split("\\|");
            text = String.format("%.1f km · %s in %s m", dNow() / 1000, parts[0], parts[1]);
        }
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.notify(NOTIFICATION_ID, buildNotification(text));
    }

    @Override
    public void onDestroy() {
        locations.removeUpdates(this);
        stopClip();
        if (tts != null) tts.shutdown();
        if (wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }
}
