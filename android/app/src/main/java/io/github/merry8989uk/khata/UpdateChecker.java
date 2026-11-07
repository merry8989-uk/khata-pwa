package io.github.merry8989uk.khata;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * In-app updates without a browser: asks GitHub Releases for the newest APK,
 * downloads it and hands it to the system installer. It installs straight over
 * the current app because the package id and the release keystore never change.
 */
final class UpdateChecker {

    private static final String RELEASES_URL =
            "https://api.github.com/repos/merry8989-uk/khata-pwa/releases/latest";
    private static final String APK_MIME = "application/vnd.android.package-archive";

    private UpdateChecker() {
    }

    /** Called at launch: only speaks up when there is something newer. */
    static void checkQuietly(Activity activity) {
        new Thread(() -> {
            Release release = fetchLatest();
            if (release == null) return;
            if (compareVersions(release.version, BuildConfig.VERSION_NAME) <= 0) return;
            activity.runOnUiThread(() -> prompt(activity, release));
        }, "khata-update-check").start();
    }

    /** Called from the web UI's "Check for updates" button through the bridge. */
    static void checkInteractively(Activity activity) {
        new Thread(() -> {
            Release release = fetchLatest();
            activity.runOnUiThread(() -> {
                if (release == null) {
                    Toast.makeText(activity, R.string.update_check_failed, Toast.LENGTH_LONG).show();
                    return;
                }
                if (compareVersions(release.version, BuildConfig.VERSION_NAME) > 0) {
                    prompt(activity, release);
                } else {
                    Toast.makeText(activity,
                            activity.getString(R.string.update_up_to_date, BuildConfig.VERSION_NAME),
                            Toast.LENGTH_LONG).show();
                }
            });
        }, "khata-update-check").start();
    }

    private static final class Release {
        final String version;
        final String apkUrl;

        Release(String version, String apkUrl) {
            this.version = version;
            this.apkUrl = apkUrl;
        }
    }

    private static Release fetchLatest() {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(RELEASES_URL).openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(8000);
            connection.setRequestProperty("Accept", "application/vnd.github+json");
            connection.setRequestProperty("User-Agent", "KhataAndroid/" + BuildConfig.VERSION_NAME);
            if (connection.getResponseCode() != 200) {
                CrashLog.note("update", "HTTP " + connection.getResponseCode());
                return null;
            }
            StringBuilder body = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) body.append(line);
            }
            JSONObject json = new JSONObject(body.toString());
            String tag = json.optString("tag_name", "").trim();
            String version = tag.startsWith("v") ? tag.substring(1) : tag;
            String apkUrl = null;
            JSONArray assets = json.optJSONArray("assets");
            if (assets != null) {
                for (int i = 0; i < assets.length(); i += 1) {
                    JSONObject asset = assets.getJSONObject(i);
                    String name = asset.optString("name", "");
                    if (name.endsWith(".apk")) {
                        apkUrl = asset.optString("browser_download_url", null);
                        break;
                    }
                }
            }
            if (version.isEmpty() || apkUrl == null) return null;
            return new Release(version, apkUrl);
        } catch (Exception error) {
            CrashLog.note("update", "check failed: " + error);
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static void prompt(Activity activity, Release release) {
        new AlertDialog.Builder(activity)
                .setTitle(activity.getString(R.string.update_title, release.version))
                .setMessage(R.string.update_message)
                .setPositiveButton(R.string.update_install, (dialog, which) -> download(activity, release))
                .setNegativeButton(android.R.string.cancel, null)
                .show();
    }

    private static void download(Activity activity, Release release) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !activity.getPackageManager().canRequestPackageInstalls()) {
            new AlertDialog.Builder(activity)
                    .setTitle(R.string.update_permission_title)
                    .setMessage(R.string.update_permission_message)
                    .setPositiveButton(R.string.update_open_settings, (dialog, which) -> {
                        Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:" + activity.getPackageName()));
                        activity.startActivity(intent);
                    })
                    .setNegativeButton(android.R.string.cancel, null)
                    .show();
            return;
        }

        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(release.apkUrl));
        request.setMimeType(APK_MIME);
        request.setTitle(activity.getString(R.string.update_title, release.version));
        request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        request.setDestinationInExternalFilesDir(activity, Environment.DIRECTORY_DOWNLOADS, "khata-update.apk");

        DownloadManager manager = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
        long downloadId = manager.enqueue(request);

        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (!DownloadManager.ACTION_DOWNLOAD_COMPLETE.equals(intent.getAction())) return;
                if (intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1) != downloadId) return;
                try {
                    context.unregisterReceiver(this);
                } catch (IllegalArgumentException ignored) {
                    // already gone
                }
                Uri apk = manager.getUriForDownloadedFile(downloadId);
                if (apk == null) {
                    Toast.makeText(activity, R.string.update_failed, Toast.LENGTH_LONG).show();
                    return;
                }
                Intent install = new Intent(Intent.ACTION_VIEW);
                install.setDataAndType(apk, APK_MIME);
                install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    activity.startActivity(install);
                } catch (Exception error) {
                    CrashLog.note("update", "install intent failed: " + error);
                    Toast.makeText(activity, R.string.update_failed, Toast.LENGTH_LONG).show();
                }
            }
        };

        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            activity.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            activity.registerReceiver(receiver, filter);
        }
        Toast.makeText(activity, R.string.update_downloading, Toast.LENGTH_SHORT).show();
    }

    /** 1.10.2 vs 1.9.9 compares numerically, not lexically. */
    static int compareVersions(String left, String right) {
        String[] a = left.split("[^0-9]");
        String[] b = right.split("[^0-9]");
        int length = Math.max(a.length, b.length);
        for (int i = 0; i < length; i += 1) {
            int x = i < a.length && !a[i].isEmpty() ? Integer.parseInt(a[i]) : 0;
            int y = i < b.length && !b[i].isEmpty() ? Integer.parseInt(b[i]) : 0;
            if (x != y) return x > y ? 1 : -1;
        }
        return 0;
    }
}
