package se.leo.runtour;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The trigger logic of the run player — the same algorithm as
 * packages/core/src/tour/runtime.ts, which owns the unit tests; the exported
 * golden traces are replayed against this class by RuntimeCheck on the JVM.
 * Pure Java on purpose: no android.* imports.
 */
public final class RunRuntime {

    public static final class Settings {
        public final double offCourseM;
        public final double offCourseSec;
        public final double triggerWindowM;
        public final double dropAfterM;
        public final double maxBackwardM;

        public Settings(double offCourseM, double offCourseSec, double triggerWindowM,
                        double dropAfterM, double maxBackwardM) {
            this.offCourseM = offCourseM;
            this.offCourseSec = offCourseSec;
            this.triggerWindowM = triggerWindowM;
            this.dropAfterM = dropAfterM;
            this.maxBackwardM = maxBackwardM;
        }

        public static Settings defaults() {
            return new Settings(60, 20, 150, 200, 100);
        }
    }

    public static final class Place {
        public final String id;
        public final double triggerD;

        public Place(String id, double triggerD) {
            this.id = id;
            this.triggerD = triggerD;
        }
    }

    /** "play:A", "drop:B", "offCourse", "onCourse" — mirrors the TS event names. */
    public interface Listener {
        void onEvent(String event, String placeId);
    }

    public static final String PENDING = "pending";
    public static final String PLAYED = "played";
    public static final String DROPPED = "dropped";
    public static final String MISSED = "missed";

    private static final double M_PER_DEG_LAT = 111_195;

    private final double[] lats;
    private final double[] lons;
    private final double[] cum;
    private final Place[] places;
    private final Settings s;

    private double d = 0;
    private boolean hasFix = false;
    private boolean off = false;
    private double offSince = Double.NaN;
    private boolean playing = false;
    private final Map<String, String> outcomes = new HashMap<>();
    private final Deque<String> queue = new ArrayDeque<>();

    public RunRuntime(double[] lats, double[] lons, Place[] places, Settings settings) {
        this.lats = lats;
        this.lons = lons;
        this.places = places.clone();
        Arrays.sort(this.places, Comparator.comparingDouble(p -> p.triggerD));
        this.s = settings;
        this.cum = new double[lats.length];
        for (int i = 1; i < lats.length; i++) {
            cum[i] = cum[i - 1] + haversine(lats[i - 1], lons[i - 1], lats[i], lons[i]);
        }
        for (Place p : places) outcomes.put(p.id, PENDING);
    }

    public double dNow() {
        return d;
    }

    public boolean isOffCourse() {
        return off;
    }

    public Place nextPlace() {
        for (Place p : places) {
            if (PENDING.equals(outcomes.get(p.id)) && p.triggerD + s.triggerWindowM > d) return p;
        }
        return null;
    }

    public String outcome(String placeId) {
        String o = outcomes.get(placeId);
        return o == null ? PENDING : o;
    }

    public List<String[]> summary() {
        List<String[]> out = new ArrayList<>();
        for (Place p : places) out.add(new String[] { p.id, outcomes.get(p.id) });
        return out;
    }

    public void update(double t, double lat, double lon, Listener listener) {
        double[] proj = project(lat, lon);
        d = proj[0];
        double offset = proj[1];

        if (offset > s.offCourseM) {
            if (Double.isNaN(offSince)) offSince = t;
            if (!off && t - offSince >= s.offCourseSec) {
                off = true;
                listener.onEvent("offCourse", null);
            }
        } else {
            offSince = Double.NaN;
            if (off) {
                off = false;
                listener.onEvent("onCourse", null);
            }
        }

        if (!off) {
            for (Place p : places) {
                if (!PENDING.equals(outcomes.get(p.id))) continue;
                if (queue.contains(p.id)) continue;
                if (d >= p.triggerD && d < p.triggerD + s.triggerWindowM) {
                    if (playing || !queue.isEmpty()) {
                        queue.addLast(p.id);
                    } else {
                        playing = true;
                        outcomes.put(p.id, PLAYED);
                        listener.onEvent("play", p.id);
                    }
                } else if (d >= p.triggerD + s.triggerWindowM) {
                    // Ran past without ever entering the window (a cut course).
                    outcomes.put(p.id, MISSED);
                }
            }
        }
        drainQueueDrops(listener);
    }

    /** The clip finished (or was skipped); maybe the next queued one starts. */
    public void clipEnded(Listener listener) {
        playing = false;
        drainQueueDrops(listener);
        String next = queue.pollFirst();
        if (next != null) {
            playing = true;
            outcomes.put(next, PLAYED);
            listener.onEvent("play", next);
        }
    }

    private void drainQueueDrops(Listener listener) {
        for (java.util.Iterator<String> it = queue.iterator(); it.hasNext(); ) {
            String id = it.next();
            Place place = null;
            for (Place p : places) if (p.id.equals(id)) place = p;
            if (place != null && d > place.triggerD + s.dropAfterM) {
                it.remove();
                outcomes.put(id, DROPPED);
                listener.onEvent("drop", id);
            }
        }
    }

    /** Returns {along, offset}; see the TS original for the forward-only rule. */
    private double[] project(double lat, double lon) {
        double mPerDegLon = M_PER_DEG_LAT * Math.cos(Math.toRadians(lat));
        double floor = hasFix ? d - s.maxBackwardM : -1;
        hasFix = true;
        double bestAlong = d;
        double bestOffset = Double.POSITIVE_INFINITY;
        int n = lats.length;
        for (int i = 0; i < n - 1; i++) {
            double ax = (lons[i] - lon) * mPerDegLon;
            double ay = (lats[i] - lat) * M_PER_DEG_LAT;
            double bx = (lons[i + 1] - lon) * mPerDegLon;
            double by = (lats[i + 1] - lat) * M_PER_DEG_LAT;
            double dx = bx - ax;
            double dy = by - ay;
            double len2 = dx * dx + dy * dy;
            double t = len2 == 0 ? 0 : -(ax * dx + ay * dy) / len2;
            if (t < 0) t = 0;
            else if (t > 1) t = 1;
            double segLen = cum[i + 1] - cum[i];
            double along = cum[i] + t * segLen;
            if (along < floor) continue;
            double cx = ax + t * dx;
            double cy = ay + t * dy;
            double offset = Math.sqrt(cx * cx + cy * cy);
            if (offset < bestOffset) {
                bestOffset = offset;
                bestAlong = along;
            }
        }
        return new double[] { bestAlong, Double.isInfinite(bestOffset) ? 0 : bestOffset };
    }

    private static double haversine(double lat1, double lon1, double lat2, double lon2) {
        double dLat = Math.toRadians(lat2 - lat1);
        double dLon = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2))
                * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 2 * 6371000 * Math.asin(Math.sqrt(a));
    }
}
