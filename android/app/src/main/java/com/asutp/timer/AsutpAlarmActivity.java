package com.asutp.timer;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.os.UserManager;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

/**
 * Нативный экран тревоги — рисуется без WebView.
 *
 * Зачем он нужен:
 *  1) После перезагрузки телефона, пока он ещё не разблокирован (direct boot),
 *     обычный MainActivity системе недоступен: полноэкранное намерение
 *     проваливалось с «Activity class ... does not exist» — экран не
 *     включался, приложение не вылезало над замком. Этот Activity объявлен
 *     directBootAware и показывает тревогу сам.
 *  2) Страховка от «WebView не успел загрузиться»: оповещение всё равно видно,
 *     даже если приложение открылось с пустым экраном.
 *
 * Если пользователь разблокирован — экран перенаправляет в MainActivity,
 * обычный путь (JS-оверлей) не меняется.
 */
public class AsutpAlarmActivity extends Activity {

    private static final String TAG = "AsutpAlarmAct";

    private boolean forwarded = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (forwardToApp()) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                setShowWhenLocked(true);
                setTurnScreenOn(true);
            }
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            setContentView(buildView());
        } catch (Exception e) {
            Log.e(TAG, "экран тревоги: " + e.getMessage());
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Телефон разблокировали, пока показывался нативный экран: переходим
        // в обычное приложение.
        forwardToApp();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // Второе оповещение пары («конец операции» + «начало следующей») приходит
        // в тот же экран, но с другим текстом — обновляем его.
        try {
            if (forwardToApp()) return;
            setContentView(buildView());
        } catch (Exception e) {
            Log.e(TAG, "обновление экрана тревоги: " + e.getMessage());
        }
    }

    /** Разблокирован ли пользователь (в direct boot — нет). */
    private boolean isUnlocked() {
        try {
            UserManager um = (UserManager) getSystemService(UserManager.class);
            return um != null && um.isUserUnlocked();
        } catch (Exception e) {
            return false;
        }
    }

    /** Заблокирован ли экран (замок или погашен). */
    private boolean isScreenLocked() {
        try {
            KeyguardManager km = (KeyguardManager) getSystemService(KeyguardManager.class);
            if (km != null && km.isKeyguardLocked()) return true;
        } catch (Throwable t) { }
        try {
            PowerManager pm = (PowerManager) getSystemService(PowerManager.class);
            return pm != null && !pm.isInteractive();
        } catch (Throwable t) {
            return false;
        }
    }

    /** Открыть обычное приложение. false — открывать нельзя (direct boot). */
    private boolean forwardToApp() {
        if (forwarded) return true;
        // Если экран заблокирован — показываем нативный экран тревоги, а не
        // приложение. Проверять надо именно экран: после перезагрузки MIUI может
        // считать пользователя «разблокированным» (сессия жива), пока экран
        // заблокирован — и тогда тревога открывала приложение вместо себя.
        if (isScreenLocked()) return false;
        if (!isUnlocked()) return false;
        forwarded = true;
        try {
            Intent app = new Intent(this, MainActivity.class);
            app.setAction(Intent.ACTION_MAIN);
            app.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_SINGLE_TOP
                    | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            if (getIntent() != null) {
                app.putExtra(AsutpAlarmReceiver.EXTRA_PAYLOAD,
                        getIntent().getStringExtra(AsutpAlarmReceiver.EXTRA_PAYLOAD));
            }
            startActivity(app);
        } catch (Exception e) {
            Log.e(TAG, "не удалось открыть приложение: " + e.getMessage());
        }
        finish();
        return true;
    }

    /** Экран тревоги: заголовок, текст события и кнопка подтверждения. */
    private View buildView() {
        String payload = getIntent() == null
                ? null : getIntent().getStringExtra(AsutpAlarmReceiver.EXTRA_PAYLOAD);
        String title = "ВНИМАНИЕ";
        String text = "";
        int id = 0;
        try {
            JSONObject o = new JSONObject(payload == null ? "{}" : payload);
            title = o.optString("title", title);
            text = o.optString("text", text);
            id = o.optInt("id", 0);
        } catch (Exception e) {
            Log.e(TAG, "битый payload: " + e.getMessage());
        }
        final int alertId = id;
        final String alertPayload = payload == null ? "{}" : payload;

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setBackgroundColor(Color.parseColor("#0A0A12"));
        root.setPadding(dp(24), dp(36), dp(24), dp(36));

        TextView badge = new TextView(this);
        badge.setText(title);
        badge.setTextColor(Color.parseColor("#FF3B47"));
        badge.setTextSize(22);
        badge.setTypeface(Typeface.DEFAULT_BOLD);
        badge.setLetterSpacing(0.15f);
        badge.setGravity(Gravity.CENTER);
        badge.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        root.addView(badge);

        TextView body = new TextView(this);
        body.setText(text);
        body.setTextColor(Color.WHITE);
        body.setTextSize(26);
        body.setGravity(Gravity.CENTER);
        body.setPadding(0, dp(20), 0, dp(40));
        body.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        root.addView(body);

        Button ok = new Button(this);
        ok.setText("✔  ПРИНЯТО / ДАЛЕЕ");
        ok.setTextColor(Color.WHITE);
        ok.setTextSize(18);
        ok.setAllCaps(false);
        ok.setBackgroundColor(Color.parseColor("#B00020"));
        ok.setPadding(dp(12), dp(18), dp(12), dp(18));
        ok.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                acknowledge(alertId, alertPayload);
            }
        });
        root.addView(ok, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        return root;
    }

    /** Подтверждение тревоги: гасим зуммер и вибрацию тем же broadcast'ом, что и кнопка в уведомлении. */
    private void acknowledge(int id, String payload) {
        try {
            Intent ack = new Intent(this, AsutpAlarmReceiver.class);
            ack.setAction(AsutpAlarmReceiver.ACTION_ACK);
            ack.putExtra(AsutpAlarmReceiver.EXTRA_ID, id);
            ack.putExtra(AsutpAlarmReceiver.EXTRA_PAYLOAD, payload);
            sendBroadcast(ack);
        } catch (Exception e) {
            Log.e(TAG, "не удалось подтвердить: " + e.getMessage());
        }
        finish();
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v,
                getResources().getDisplayMetrics());
    }
}
