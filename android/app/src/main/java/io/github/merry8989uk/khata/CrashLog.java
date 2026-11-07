package io.github.merry8989uk.khata;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.os.Build;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Native diagnostics for the Android shell, kept separate from the web app's own
 * Diagnostics screen. Uncaught crashes and shell events are appended to
 * filesDir/khata-native.log (capped), and the next launch offers to share it.
 * Collection is always on: a crash that cannot be reported is a crash nobody can
 * fix, and the file never leaves the device unless the user shares it.
 */
final class CrashLog {

    private static final long MAX_BYTES = 256 * 1024;
    private static File logFile;

    private CrashLog() {
    }

    static synchronized void install(Activity activity) {
        logFile = new File(activity.getFilesDir(), "khata-native.log");
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            StringWriter stack = new StringWriter();
            error.printStackTrace(new PrintWriter(stack));
            note("crash", "uncaught in " + thread.getName() + "\n" + stack);
            if (previous != null) previous.uncaughtException(thread, error);
        });
        note("app", "launch v" + BuildConfig.VERSION_NAME
                + " sdk=" + Build.VERSION.SDK_INT
                + " device=" + Build.MANUFACTURER + " " + Build.MODEL);
    }

    static synchronized void note(String tag, String message) {
        if (logFile == null) return;
        try {
            if (logFile.length() > MAX_BYTES) {
                // Keep the tail; a rotated head is better than an unbounded file.
                byte[] tail = new byte[(int) (MAX_BYTES / 2)];
                try (java.io.RandomAccessFile raf = new java.io.RandomAccessFile(logFile, "r")) {
                    raf.seek(logFile.length() - tail.length);
                    raf.readFully(tail);
                }
                try (FileOutputStream out = new FileOutputStream(logFile, false)) {
                    out.write("[log rotated]\n".getBytes(StandardCharsets.UTF_8));
                    out.write(tail);
                }
            }
            String stamp = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).format(new Date());
            String line = stamp + " [" + tag + "] " + message + "\n";
            try (FileOutputStream out = new FileOutputStream(logFile, true)) {
                out.write(line.getBytes(StandardCharsets.UTF_8));
            }
        } catch (IOException ignored) {
            // Logging must never take the app down.
        }
    }

    /** After an unclean exit, offer the log before the user starts working. */
    static void offerShareIfPresent(Activity activity) {
        final File file = new File(activity.getFilesDir(), "khata-native.log");
        if (!file.exists() || file.length() == 0) return;
        final String text;
        try {
            text = readAll(file);
        } catch (IOException error) {
            return;
        }
        if (!text.contains("[crash]")) return; // nothing alarming to report

        new AlertDialog.Builder(activity)
                .setTitle(R.string.logs_title)
                .setMessage(R.string.logs_message)
                .setPositiveButton(R.string.logs_share, (dialog, which) -> {
                    Intent send = new Intent(Intent.ACTION_SEND);
                    send.setType("text/plain");
                    send.putExtra(Intent.EXTRA_SUBJECT, "Khata Android log");
                    send.putExtra(Intent.EXTRA_TEXT, text);
                    activity.startActivity(Intent.createChooser(send, activity.getString(R.string.logs_share)));
                })
                .setNeutralButton(R.string.logs_clear, (dialog, which) -> {
                    //noinspection ResultOfMethodCallIgnored
                    file.delete();
                })
                .setNegativeButton(android.R.string.cancel, null)
                .show();
    }

    private static String readAll(File file) throws IOException {
        byte[] bytes = new byte[(int) Math.min(file.length(), MAX_BYTES)];
        try (java.io.FileInputStream in = new java.io.FileInputStream(file)) {
            int read = in.read(bytes);
            return read > 0 ? new String(bytes, 0, read, StandardCharsets.UTF_8) : "";
        }
    }
}
