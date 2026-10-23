package se.leo.runtour;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/** Tours live in files/tours/&lt;id&gt;/ as tour.json plus one audio file per place. */
public final class Tours {

    private Tours() {}

    public static File root(Context ctx) {
        File dir = new File(ctx.getFilesDir(), "tours");
        dir.mkdirs();
        return dir;
    }

    public static File dir(Context ctx, String id) {
        return new File(root(ctx), sanitize(id));
    }

    /** Only names that cannot escape the tour directory. */
    public static String sanitize(String name) {
        return name.replaceAll("[^a-zA-Z0-9._-]", "_");
    }

    public static String readStream(InputStream in) throws Exception {
        byte[] buf = new byte[8192];
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    /** Validate just enough to file it; the web app does the full validation. */
    public static String save(Context ctx, String json) throws Exception {
        JSONObject tour = new JSONObject(json);
        if (tour.getInt("version") != 1) throw new Exception("unsupported tour version");
        String id = sanitize(tour.getString("id"));
        tour.getJSONArray("places");
        File dir = dir(ctx, id);
        dir.mkdirs();
        File file = new File(dir, "tour.json");
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(json.getBytes(StandardCharsets.UTF_8));
        }
        return id;
    }

    public static String read(Context ctx, String id) throws Exception {
        File file = new File(dir(ctx, id), "tour.json");
        try (FileInputStream in = new FileInputStream(file)) {
            return readStream(in);
        }
    }

    public static void delete(Context ctx, String id) {
        File dir = dir(ctx, id);
        File[] files = dir.listFiles();
        if (files != null) for (File f : files) f.delete();
        dir.delete();
    }

    /** [{id, name, places, audio}] for the shelf in the web app. */
    public static String list(Context ctx) {
        JSONArray out = new JSONArray();
        File[] dirs = root(ctx).listFiles();
        if (dirs == null) return out.toString();
        for (File dir : dirs) {
            File meta = new File(dir, "tour.json");
            if (!meta.isFile()) continue;
            try (FileInputStream in = new FileInputStream(meta)) {
                JSONObject tour = new JSONObject(readStream(in));
                JSONObject entry = new JSONObject();
                entry.put("id", dir.getName());
                entry.put("name", tour.optString("name", dir.getName()));
                entry.put("places", tour.getJSONArray("places").length());
                int audio = 0;
                File[] files = dir.listFiles();
                if (files != null) for (File f : files) if (f.getName().endsWith(".wav")) audio++;
                entry.put("audio", audio);
                out.put(entry);
            } catch (Exception ignored) {
                // An unreadable directory is not a tour.
            }
        }
        return out.toString();
    }
}
