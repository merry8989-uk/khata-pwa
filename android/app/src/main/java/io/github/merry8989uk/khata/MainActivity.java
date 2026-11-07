package io.github.merry8989uk.khata;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Khata for Android: a full-screen WebView shell around the offline-first PWA.
 *
 * The web app owns every feature (ledger, settings, diagnostics, About). This shell
 * adds the four things a browser tab cannot do:
 *   1. full-screen immersive chrome,
 *   2. saving PDF statements, JSON backups and log exports to Downloads (blob
 *      downloads never reach the WebView's DownloadListener, so they come through
 *      the KhataAndroid bridge instead),
 *   3. sending tel:, mailto:, wa.me and https links that are not the app's own
 *      origin out to the system,
 *   4. checking GitHub Releases for a newer APK and installing it in place.
 */
public class MainActivity extends Activity {

    static final String APP_HOST = "merry8989-uk.github.io";
    static final String APP_PATH_PREFIX = "/khata-pwa/";
    static final String APP_URL = "https://merry8989-uk.github.io/khata-pwa/app/";
    private static final int WRITE_PERMISSION_REQUEST = 4711;

    private WebView webView;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private String pendingName;
    private String pendingMime;
    private String pendingBase64;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        CrashLog.install(this);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        FrameLayout root = new FrameLayout(this);
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        webView = new WebView(this);
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(webView);
        setContentView(root);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " KhataAndroid/" + BuildConfig.VERSION_NAME);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(true);
        }
        CookieManager.getInstance().setAcceptCookie(true);

        webView.addJavascriptInterface(new Bridge(), "KhataAndroid");
        webView.setWebViewClient(new Client());
        webView.setWebChromeClient(new Chrome());
        webView.setDownloadListener(new Downloads());
        webView.setBackgroundColor(0xFFF8FAFC);

        enterImmersive();

        if (savedInstanceState == null) {
            webView.loadUrl(APP_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }

        // Silent update check on launch; the dialog only appears when a newer
        // release exists, so a shopkeeper never sees it during a sale.
        UpdateChecker.checkQuietly(this);
        CrashLog.offerShareIfPresent(this);
    }

    private void enterImmersive() {
        View decor = getWindow().getDecorView();
        decor.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            getWindow().getAttributes().layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) enterImmersive();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        io.shutdown();
        if (webView != null) {
            webView.removeJavascriptInterface("KhataAndroid");
            webView.destroy();
        }
        super.onDestroy();
    }

    /* ------------------------------------------------------------ navigation */

    private boolean isAppUrl(Uri uri) {
        return uri != null
                && "https".equals(uri.getScheme())
                && APP_HOST.equals(uri.getHost())
                && uri.getPath() != null
                && uri.getPath().startsWith(APP_PATH_PREFIX);
    }

    private void openExternally(Uri uri) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show();
        }
    }

    private final class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (isAppUrl(uri)) return false; // the ledger itself stays in the shell
            openExternally(uri); // tel:, mailto:, wa.me, instagram, anything else
            return true;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            Uri uri = Uri.parse(url);
            if (isAppUrl(uri)) return false;
            openExternally(uri);
            return true;
        }
    }

    private final class Chrome extends WebChromeClient {
        @Override
        public boolean onConsoleMessage(ConsoleMessage message) {
            CrashLog.note("console/" + message.messageLevel(), message.message());
            return true;
        }
    }

    /** Handles http(s) downloads (for example a WhatsApp media link inside the app). */
    private final class Downloads implements DownloadListener {
        @Override
        public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                    String mimeType, long contentLength) {
            if (url.startsWith("blob:") || url.startsWith("data:")) {
                Toast.makeText(MainActivity.this, R.string.download_unsupported, Toast.LENGTH_LONG).show();
                return;
            }
            try {
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                request.setMimeType(mimeType);
                request.addRequestHeader("User-Agent", userAgent);
                request.setNotificationVisibility(
                        DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setDestinationInExternalPublicDir(
                        Environment.DIRECTORY_DOWNLOADS, "khata-" + System.currentTimeMillis());
                DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                manager.enqueue(request);
                Toast.makeText(MainActivity.this, R.string.download_started, Toast.LENGTH_SHORT).show();
            } catch (Exception error) {
                CrashLog.note("download", String.valueOf(error));
                Toast.makeText(MainActivity.this, R.string.download_failed, Toast.LENGTH_LONG).show();
            }
        }
    }

    /* ------------------------------------------------------- JavaScript bridge */

    /**
     * Called from src/js/ui.js when the page runs inside this shell, because a
     * blob: URL never reaches the WebView download listener.
     */
    private final class Bridge {
        @JavascriptInterface
        public void saveFile(String name, String mime, String base64) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                    && checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    != PackageManager.PERMISSION_GRANTED) {
                pendingName = name;
                pendingMime = mime;
                pendingBase64 = base64;
                requestPermissions(
                        new String[]{android.Manifest.permission.WRITE_EXTERNAL_STORAGE},
                        WRITE_PERMISSION_REQUEST);
                return;
            }
            writeFile(name, mime, base64);
        }

        @JavascriptInterface
        public String platform() {
            return "android/" + BuildConfig.VERSION_NAME;
        }

        /** The web About screen's "Check for updates" calls this in the shell. */
        @JavascriptInterface
        public void checkAppUpdate() {
            runOnUiThread(() -> UpdateChecker.checkInteractively(MainActivity.this));
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != WRITE_PERMISSION_REQUEST) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED
                && pendingBase64 != null) {
            writeFile(pendingName, pendingMime, pendingBase64);
        } else {
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_LONG).show();
        }
        pendingName = null;
        pendingMime = null;
        pendingBase64 = null;
    }

    private void writeFile(String name, String mime, String base64) {
        final String safeName = name == null || name.trim().isEmpty() ? "khata-file" : name.replaceAll("[^\\w.\\-]+", "_");
        final String type = mime == null || mime.isEmpty() ? "application/octet-stream" : mime;
        final byte[] bytes = Base64.decode(base64, Base64.DEFAULT);

        io.execute(() -> {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    android.content.ContentValues values = new android.content.ContentValues();
                    values.put(MediaStore.Downloads.DISPLAY_NAME, safeName);
                    values.put(MediaStore.Downloads.MIME_TYPE, type);
                    values.put(MediaStore.Downloads.IS_PENDING, 1);
                    Uri target = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (target == null) throw new IllegalStateException("MediaStore refused the insert");
                    try (OutputStream out = getContentResolver().openOutputStream(target)) {
                        if (out == null) throw new IllegalStateException("no output stream");
                        out.write(bytes);
                    }
                    values.clear();
                    values.put(MediaStore.Downloads.IS_PENDING, 0);
                    getContentResolver().update(target, values, null, null);
                } else {
                    File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                    if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("no Downloads dir");
                    File file = new File(dir, safeName);
                    try (FileOutputStream out = new FileOutputStream(file)) {
                        out.write(bytes);
                    }
                }
                CrashLog.note("download", "saved " + safeName + " (" + bytes.length + " bytes)");
                runOnUiThread(() -> Toast.makeText(
                        MainActivity.this, getString(R.string.download_saved, safeName), Toast.LENGTH_LONG).show());
            } catch (Exception error) {
                CrashLog.note("download-failed", String.valueOf(error));
                runOnUiThread(() -> Toast.makeText(
                        MainActivity.this, R.string.download_failed, Toast.LENGTH_LONG).show());
            }
        });
    }

    void showMessage(String title, String message) {
        new AlertDialog.Builder(this)
                .setTitle(title)
                .setMessage(message)
                .setPositiveButton(android.R.string.ok, null)
                .show();
    }
}
