package io.github.merry8989uk.khata;

import android.Manifest;
import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.telephony.SmsManager;
import android.webkit.WebView;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Free SMS from the phone's own SIM, so no gateway, no top-up and no per-message fee.
 *
 * The Worker used to text customers through Fast2SMS or Twilio. This does the same
 * job with SmsManager on the device that already runs the ledger, which means it
 * works offline too. Limits are real and enforced here: one SIM's daily allowance
 * (90 messages by default, under the usual 100/day recharge cap) and one send per
 * entry, tracked by the entry's own id.
 *
 * Results go back to the web layer through window.__khataSmsResult so the ledger can
 * mark an entry "SMS sent" or "SMS failed" instead of guessing.
 */
final class SmsGateway {

    static final int REQUEST_CODE_PERMISSION = 4712;
    static final int DAILY_CAP = 90;
    private static final String PREFS = "khata_sms";

    private static final AtomicInteger SEQUENCE = new AtomicInteger(1);

    private final Activity activity;
    private final WebView webView;

    SmsGateway(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    static boolean hasPermission(Context context) {
        return context.checkSelfPermission(Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED;
    }

    /** {"sent":n,"cap":90,"date":"2026-11-07"} - read by Settings. */
    String quotaJson() {
        return String.format(Locale.US, "{\"sent\":%d,\"cap\":%d,\"date\":\"%s\"}",
                sentToday(), DAILY_CAP, today());
    }

    private SharedPreferences prefs() {
        return activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private String today() {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
    }

    private int sentToday() {
        SharedPreferences prefs = prefs();
        if (!today().equals(prefs.getString("date", ""))) return 0;
        return prefs.getInt("count", 0);
    }

    private void countOne() {
        SharedPreferences prefs = prefs();
        int next = today().equals(prefs.getString("date", "")) ? prefs.getInt("count", 0) + 1 : 1;
        prefs.edit().putString("date", today()).putInt("count", next).apply();
    }

    /**
     * @param entryId ledger entry id, echoed back so the page can mark the right row
     */
    void send(String entryId, String number, String body) {
        if (!hasPermission(activity)) {
            callback(entryId, "permission_required", "SEND_SMS not granted");
            activity.requestPermissions(new String[]{Manifest.permission.SEND_SMS}, REQUEST_CODE_PERMISSION);
            return;
        }
        String digits = number == null ? "" : number.replaceAll("[^0-9+]", "");
        if (digits.length() < 10) {
            callback(entryId, "invalid_number", digits);
            return;
        }
        if (body == null || body.trim().isEmpty()) {
            callback(entryId, "empty_body", null);
            return;
        }
        if (sentToday() >= DAILY_CAP) {
            callback(entryId, "daily_cap", "cap " + DAILY_CAP);
            return;
        }

        try {
            SmsManager manager = SmsManager.getDefault();
            ArrayList<String> parts = manager.divideMessage(body);
            int sequence = SEQUENCE.getAndIncrement();

            ArrayList<PendingIntent> sentIntents = new ArrayList<>();
            for (int i = 0; i < parts.size(); i += 1) {
                Intent sent = new Intent("io.github.merry8989uk.khata.SMS_SENT");
                sent.setPackage(activity.getPackageName());
                sent.putExtra("entry_id", entryId);
                sent.putExtra("sequence", sequence);
                sentIntents.add(PendingIntent.getBroadcast(
                        activity, sequence * 100 + i, sent,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
            }

            manager.sendMultipartTextMessage(digits, null, parts, sentIntents, null);
            countOne();
            callback(entryId, "queued", null);
            CrashLog.note("sms", "queued " + parts.size() + " part(s) to " + digits);
        } catch (Exception error) {
            CrashLog.note("sms-failed", String.valueOf(error));
            callback(entryId, "error", String.valueOf(error));
        }
    }

    /** The radio reports back here; "sent" means the network accepted it. */
    static BroadcastReceiver receiver(WebView webView) {
        return new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String entryId = intent.getStringExtra("entry_id");
                int resultCode = getResultCode();
                if (resultCode == Activity.RESULT_OK) {
                    CrashLog.note("sms", "sent " + entryId);
                    evaluate(webView, entryId, "sent", null);
                } else {
                    String reason = "radio_error_" + resultCode;
                    CrashLog.note("sms-failed", entryId + " " + reason);
                    evaluate(webView, entryId, "failed", reason);
                }
            }
        };
    }

    static IntentFilter filter() {
        return new IntentFilter("io.github.merry8989uk.khata.SMS_SENT");
    }

    private void callback(String entryId, String status, String detail) {
        evaluate(webView, entryId, status, detail);
    }

    private static void evaluate(WebView webView, String entryId, String status, String detail) {
        if (webView == null) return;
        String payload = String.format(
                Locale.US, "{\"id\":%s,\"status\":%s,\"detail\":%s}",
                quote(entryId), quote(status), quote(detail));
        webView.post(() -> webView.evaluateJavascript(
                "window.__khataSmsResult && window.__khataSmsResult(" + payload + ")", null));
    }

    private static String quote(String value) {
        if (value == null) return "null";
        return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ") + "\"";
    }
}
