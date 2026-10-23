package se.leo.runtour;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;

/**
 * Replays the golden traces exported by packages/core/test/runtime.test.ts
 * against RunRuntime. Runs on the plain JVM (no android classes):
 *   java -cp build/classes se.leo.runtour.RuntimeCheck test/runtime-cases.txt
 * Exit 0 when every case matches, 1 otherwise.
 */
public final class RuntimeCheck {

    public static void main(String[] args) throws IOException {
        List<String> lines = Files.readAllLines(Paths.get(args[0]), StandardCharsets.UTF_8);
        int cases = 0;
        int failures = 0;
        String name = null;
        RunRuntime runtime = null;
        RunRuntime.Settings settings = null;
        double[] lats = null;
        double[] lons = null;
        List<RunRuntime.Place> places = new ArrayList<>();
        int step = 0;

        for (String line : lines) {
            line = line.trim();
            if (line.isEmpty() || line.startsWith("#")) continue;
            String[] parts = line.split("\\s+");
            switch (parts[0]) {
                case "case":
                    name = parts[1];
                    runtime = null;
                    settings = null;
                    lats = null;
                    places = new ArrayList<>();
                    step = 0;
                    break;
                case "settings":
                    settings = new RunRuntime.Settings(
                            Double.parseDouble(parts[1]), Double.parseDouble(parts[2]),
                            Double.parseDouble(parts[3]), Double.parseDouble(parts[4]),
                            Double.parseDouble(parts[5]));
                    break;
                case "route": {
                    lats = new double[parts.length - 1];
                    lons = new double[parts.length - 1];
                    for (int i = 1; i < parts.length; i++) {
                        String[] ll = parts[i].split(",");
                        lats[i - 1] = Double.parseDouble(ll[0]);
                        lons[i - 1] = Double.parseDouble(ll[1]);
                    }
                    break;
                }
                case "place":
                    places.add(new RunRuntime.Place(parts[1], Double.parseDouble(parts[2])));
                    break;
                case "fix":
                case "end": {
                    if (runtime == null) {
                        runtime = new RunRuntime(lats, lons,
                                places.toArray(new RunRuntime.Place[0]), settings);
                        cases++;
                    }
                    List<String> got = new ArrayList<>();
                    RunRuntime.Listener listener = (event, placeId) ->
                            got.add(placeId == null ? event : event + ":" + placeId);
                    int arrow = line.indexOf("->");
                    String expected = arrow < 0 ? "" : line.substring(arrow + 2).trim();
                    if (parts[0].equals("fix")) {
                        runtime.update(Double.parseDouble(parts[1]),
                                Double.parseDouble(parts[2]), Double.parseDouble(parts[3]),
                                listener);
                    } else {
                        runtime.clipEnded(listener);
                    }
                    String gotJoined = String.join(" ", got);
                    step++;
                    if (!gotJoined.equals(expected)) {
                        failures++;
                        System.err.println("MISMATCH in case " + name + " step " + step
                                + ": expected [" + expected + "] got [" + gotJoined + "]");
                    }
                    break;
                }
                case "endcase":
                    break;
                default:
                    System.err.println("unknown line: " + line);
                    failures++;
            }
        }
        System.out.println(cases + " cases replayed, " + failures + " mismatches");
        System.exit(failures == 0 ? 0 : 1);
    }
}
