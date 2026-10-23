package se.leo.runtour;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.util.List;

/**
 * The native run screen: light on purpose — next place and the distance to
 * it, four buttons, and the end-of-run summary. The WebView stays out of it.
 */
public class RunActivity extends Activity {

    public static final String EXTRA_TOUR_ID = "tourId";
    private static final int REQ_PERMISSIONS = 1;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private RunService service;
    private boolean summaryShown = false;
    private String tourId;

    private TextView title;
    private TextView nextPlace;
    private TextView statusLine;
    private Button pauseButton;
    private LinearLayout summaryBox;

    private final ServiceConnection connection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder binder) {
            service = ((RunService.LocalBinder) binder).service();
            if (!service.isStarted()) {
                Intent start = new Intent(RunActivity.this, RunService.class)
                        .setAction(RunService.ACTION_START)
                        .putExtra(RunService.EXTRA_TOUR_ID, tourId);
                if (Build.VERSION.SDK_INT >= 26) startForegroundService(start);
                else startService(start);
            }
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            service = null;
        }
    };

    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            render();
            handler.postDelayed(this, 1000);
        }
    };

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        tourId = getIntent().getStringExtra(EXTRA_TOUR_ID);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(28), dp(20), dp(20));

        title = text(18, false);
        nextPlace = text(26, true);
        nextPlace.setGravity(Gravity.CENTER);
        nextPlace.setPadding(0, dp(28), 0, dp(28));
        statusLine = text(15, false);

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        pauseButton = button("Pause", () -> send(RunService.ACTION_PAUSE));
        buttons.addView(pauseButton);
        buttons.addView(button("Skip", () -> send(RunService.ACTION_SKIP)));
        buttons.addView(button("Repeat", () -> send(RunService.ACTION_REPEAT)));
        buttons.addView(button("Finish", () -> send(RunService.ACTION_FINISH)));

        summaryBox = new LinearLayout(this);
        summaryBox.setOrientation(LinearLayout.VERTICAL);

        root.addView(title);
        root.addView(nextPlace);
        root.addView(statusLine);
        root.addView(buttons);
        root.addView(summaryBox);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(root);
        setContentView(scroll);

        requestNeededPermissions();
    }

    private void requestNeededPermissions() {
        if (checkSelfPermission("android.permission.ACCESS_FINE_LOCATION")
                != PackageManager.PERMISSION_GRANTED
                || (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                != PackageManager.PERMISSION_GRANTED)) {
            requestPermissions(new String[] {
                    "android.permission.ACCESS_FINE_LOCATION",
                    "android.permission.POST_NOTIFICATIONS",
            }, REQ_PERMISSIONS);
        } else {
            begin();
        }
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] results) {
        super.onRequestPermissionsResult(req, perms, results);
        if (req != REQ_PERMISSIONS) return;
        if (checkSelfPermission("android.permission.ACCESS_FINE_LOCATION")
                != PackageManager.PERMISSION_GRANTED) {
            Toast.makeText(this, "The run player needs GPS to trigger the audio.",
                    Toast.LENGTH_LONG).show();
            finish();
            return;
        }
        begin();
    }

    private void begin() {
        askBatteryExemption();
        bindService(new Intent(this, RunService.class), connection, Context.BIND_AUTO_CREATE);
        handler.post(poll);
    }

    /** One line of why, then the system dialog; some phones kill plain services. */
    private void askBatteryExemption() {
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm.isIgnoringBatteryOptimizations(getPackageName())) return;
        Toast.makeText(this,
                "Allow RunTour to ignore battery optimisation so audio keeps playing with the screen off.",
                Toast.LENGTH_LONG).show();
        try {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getPackageName())));
        } catch (Exception ignored) {
            // Some builds hide the dialog; the service still runs on most.
        }
    }

    private void send(String action) {
        startService(new Intent(this, RunService.class).setAction(action));
    }

    private void render() {
        if (service == null) return;
        title.setText(service.tourName());
        if (service.isFinished()) {
            if (!summaryShown) showSummary();
            return;
        }
        String label = service.nextPlaceLabel();
        if (label == null) {
            nextPlace.setText("No places ahead");
        } else {
            String[] parts = label.split("\\|");
            nextPlace.setText(parts[0] + "\n" + parts[1] + " m");
        }
        String state = service.isPaused() ? "paused"
                : service.offCourse() ? "off course" : "on course";
        statusLine.setText(String.format("%.2f km of %.2f · %d:%02d · %s",
                service.dNow() / 1000, service.tourDistance() / 1000,
                service.elapsedSeconds() / 60, service.elapsedSeconds() % 60, state));
        pauseButton.setText(service.isPaused() ? "Resume" : "Pause");
    }

    private void showSummary() {
        summaryShown = true;
        nextPlace.setText("Run finished");
        statusLine.setText("");
        summaryBox.removeAllViews();
        List<String> lines = service.summaryLines();
        TextView heading = text(16, true);
        heading.setText("Places");
        summaryBox.addView(heading);
        for (String line : lines) {
            String[] parts = line.split("\t", 2);
            String mark = parts[0].equals(RunRuntime.PLAYED) ? "✓"
                    : parts[0].equals(RunRuntime.DROPPED) ? "↷"
                    : parts[0].equals(RunRuntime.MISSED) ? "✗" : "·";
            TextView row = text(15, false);
            row.setText(mark + "  " + parts[1] + "  (" + parts[0] + ")");
            summaryBox.addView(row);
        }
        handler.removeCallbacks(poll);
    }

    private TextView text(int sp, boolean bold) {
        TextView v = new TextView(this);
        v.setTextSize(sp);
        if (bold) v.setTypeface(Typeface.DEFAULT_BOLD);
        return v;
    }

    private Button button(String label, Runnable action) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        b.setOnClickListener(v -> action.run());
        return b;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(poll);
        if (service != null) unbindService(connection);
        super.onDestroy();
    }
}
