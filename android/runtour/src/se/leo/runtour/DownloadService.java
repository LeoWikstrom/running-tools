package se.leo.runtour;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.IBinder;

/**
 * A notification-only foreground service for area downloads: the fetches run
 * in the WebView's JavaScript, but a minimised app without a foreground
 * service gets frozen and the download dies with it. The service does no
 * work of its own — it exists so the process keeps its network and CPU, and
 * so the user sees why.
 */
public class DownloadService extends Service {

    static final String ACTION_STATUS = "se.leo.runtour.DOWNLOAD_STATUS";
    static final String EXTRA_TEXT = "text";
    // "download" (v1) was IMPORTANCE_LOW — silent section, no status-bar icon
    // on many phones. A channel's importance is frozen at creation, so the
    // visible replacement needs a new id.
    private static final String CHANNEL = "downloads";
    private static final int NOTIFICATION_ID = 3;
    /** Separate id: the finished notice must survive stopForeground(REMOVE). */
    private static final int FINISHED_ID = 4;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String text = intent != null ? intent.getStringExtra(EXTRA_TEXT) : null;
        if (text == null || text.isEmpty()) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }
        ensureChannel(this);
        startForeground(NOTIFICATION_ID, buildNotification(text));
        return START_NOT_STICKY;
    }

    /** A dismissible "done" notice, posted directly — no service needed. */
    static void postFinished(android.content.Context ctx, String text) {
        ensureChannel(ctx);
        Intent open = new Intent(ctx, MainActivity.class);
        PendingIntent content = PendingIntent.getActivity(ctx, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_run)
                .setContentTitle("Area download finished")
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(content)
                .setAutoCancel(true)
                .build();
        ctx.getSystemService(NotificationManager.class).notify(FINISHED_ID, n);
    }

    private static void ensureChannel(android.content.Context ctx) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        NotificationChannel ch =
                new NotificationChannel(CHANNEL, "Downloads", NotificationManager.IMPORTANCE_DEFAULT);
        // Visible in the status bar, but a progress tick must not ding or buzz.
        ch.setSound(null, null);
        ch.enableVibration(false);
        nm.createNotificationChannel(ch);
        nm.deleteNotificationChannel("download");
    }

    private Notification buildNotification(String text) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent content = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_run)
                .setContentTitle("Downloading area")
                .setContentText(text)
                .setContentIntent(content)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .build();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
