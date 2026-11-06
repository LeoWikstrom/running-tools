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
    private static final String CHANNEL = "download";
    private static final int NOTIFICATION_ID = 3;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String text = intent != null ? intent.getStringExtra(EXTRA_TEXT) : null;
        if (text == null || text.isEmpty()) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }
        createChannel();
        startForeground(NOTIFICATION_ID, buildNotification(text));
        return START_NOT_STICKY;
    }

    private void createChannel() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(
                new NotificationChannel(CHANNEL, "Downloads", NotificationManager.IMPORTANCE_LOW));
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
