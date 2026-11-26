package com.asutp.timer;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.res.AssetManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.os.UserManager;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.File;

/**
 * Экран тревоги — нативный, без WebView.
 *
 * Показывается поверх экрана блокировки, когда сработал системный будильник
 * смены. Подтверждение — свайп ползунка (как Slide-to-Unlock в настройках),
 * а не кнопка: так тревогу можно подтвердить, не целясь в кнопку.
 *
 * Стиль — тот же киберпанк, что и в приложении, но сам экран отдельный:
 * полноэкранный блок с рамкой, сканлайнами и ползунком подтверждения.
 */
public class AsutpAlarmActivity extends Activity {

    private static final String TAG = "AsutpAlarmAct";

    /** Фон окна (необязательный): кладётся в assets/, при отсутствии — тёмный фон. */
    private static final String BG_ASSET = "rebecca.jpg";

    /** Показать окно поверх всего (тест из настроек), даже если телефон разблокирован. */
    public static final String EXTRA_FORCE_SHOW = "asutp_force_show";

    // Палитра — как в www/css/styles.css (:root)
    private static final int C_BG = 0xFF08080C;
    private static final int C_RED = 0xFFFF003C;
    private static final int C_CYAN = 0xFF00F0FF;
    private static final int C_YELLOW = 0xFFFCEE09;
    private static final int C_TEXT = 0xFFE2E8F0;
    private static final int C_MUTED = 0xFF64748B;

    private boolean forwarded = false;

    // Бейдж — чтобы перекрасить при подтверждении
    private TextView badgeView;

    // Ползунок подтверждения
    private FrameLayout swipeBar;
    private TextView swipeThumb;
    private View swipeFill;
    private boolean swiping = false;
    private float swipeStartX = 0f;
    private float swipeBaseX = 0f;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Только портрет: манифеста мало — окно запускается и программно.
        try {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        } catch (Exception e) {
            Log.w(TAG, "ориентация: " + e.getMessage());
        }

        // Показываем поверх замка
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            try {
                setShowWhenLocked(true);
                setTurnScreenOn(true);
            } catch (Exception e) {
                Log.w(TAG, "showWhenLocked: " + e.getMessage());
            }
        }
        try {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } catch (Exception e) {
            Log.w(TAG, "keepScreenOn: " + e.getMessage());
        }

        if (forwardToApp()) return;
        try {
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
        try {
            if (forwardToApp()) return;
            setContentView(buildView());
        } catch (Exception e) {
            Log.e(TAG, "обновление экрана тревоги: " + e.getMessage());
        }
    }

    // ---------- ДАННЫЕ ТРЕВОГИ ----------

    private JSONObject payloadObj() {
        try {
            String p = getIntent() == null ? null
                    : getIntent().getStringExtra(AsutpAlarmReceiver.EXTRA_PAYLOAD);
            if (p == null || p.isEmpty()) return new JSONObject();
            return new JSONObject(p);
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private int payloadId() {
        return payloadObj().optInt("id", 0);
    }

    /** Перерыв — жёлтая тема, как в веб-версии (break-mode). */
    private boolean isBreak() {
        return "break".equals(payloadObj().optString("mode", ""));
    }

    // ---------- ЭКРАН ----------

    private View buildView() {
        final int accent = isBreak() ? C_YELLOW : C_RED;
        final int id = payloadId();
        final String payload = getIntent() == null ? "{}"
                : getIntent().getStringExtra(AsutpAlarmReceiver.EXTRA_PAYLOAD);
        JSONObject o = payloadObj();
        String title = o.optString("title", "ВНИМАНИЕ");
        String text = o.optString("text", "");

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(C_BG);

        // Фон-картинка (необязательная) + вуаль, чтобы текст читался
        View bg = buildBackground();
        if (bg != null) {
            root.addView(bg, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
        View veil = new View(this);
        GradientDrawable veilBg = new GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                new int[]{0x00000000, 0xCC08080C, 0xF208080C});
        veil.setBackground(veilBg);
        root.addView(veil, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // Рамка и пульсирующее свечение — как alarmFlash в веб-версии.
        // Рамка — отдельным слоем ПОД содержимым, иначе мигает и сам текст.
        final FrameView frame = new FrameView(accent);
        frame.setClickable(false);
        root.addView(frame, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        pulse(frame);

        // Сканлайн — бегущая полоса (как body::after в веб-версии).
        // Идёт под содержимым, чтобы не перечёркивать текст.
        View line = new View(this);
        line.setBackgroundColor(0x5500F0FF);
        FrameLayout.LayoutParams llp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(2));
        root.addView(line, llp);
        startScanline(line);

        // Содержимое — у нижнего края экрана: бейдж, название блока и ползунок
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setGravity(Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        int screenH = getResources().getDisplayMetrics().heightPixels;
        content.setPadding(dp(26), dp(36), dp(26), Math.max(dp(36), screenH / 10));
        FrameLayout.LayoutParams clp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        clp.bottomMargin = dp(80);      // как в прототипе: отступ от низа экрана
        root.addView(content, clp);

        // Бейдж
        TextView badge = new TextView(this);
        badgeView = badge;
        badge.setText(title);
        // На жёлтом (перерыв) текст чёрный — как .break-mode .alarm-badge в вебе
        badge.setTextColor(isBreak() ? Color.BLACK : Color.WHITE);
        badge.setTextSize(13);
        badge.setTypeface(Typeface.DEFAULT_BOLD);
        badge.setLetterSpacing(0.22f);
        badge.setGravity(Gravity.CENTER);
        badge.setPadding(dp(14), dp(6), dp(14), dp(6));
        badge.setBackground(solid(accent));
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        blp.bottomMargin = dp(18);
        content.addView(badge, blp);

        // Текст события
        TextView titleView = new TextView(this);
        titleView.setText(text);
        titleView.setTextColor(C_TEXT);
        titleView.setTextSize(26);
        titleView.setTypeface(Typeface.DEFAULT_BOLD);
        titleView.setGravity(Gravity.CENTER);
        titleView.setLineSpacing(0f, 1.15f);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tlp.bottomMargin = dp(10);
        content.addView(titleView, tlp);

        // Ползунок подтверждения (вместо кнопки)
        buildSwipeBar(id, payload, accent);
        content.addView(swipeBar, (LinearLayout.LayoutParams) swipeBar.getLayoutParams());

        return root;
    }

    // ---------- ФОН-КАРТИНКА (необязательная) ----------

    /**
     * Фон экрана тревоги.
     *
     * Источники по очереди:
     * 1. картинка, выбранная пользователем (в device-protected хранилище —
     *    доступна и до разблокировки телефона);
     * 2. картинка, вложенная в сборку (assets/) — если её положили при сборке;
     * 3. ничего → тёмный фон с неоновой рамкой.
     *
     * Любая ошибка (файла нет / битый / не хватает памяти) не ломает окно:
     * оно в любом случае работоспособно.
     */
    private View buildBackground() {
        ImageView iv = new ImageView(this);
        iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
        try {
            // 1. Выбранный пользователем фон
            Bitmap chosen = loadChosenBackground();
            if (chosen != null) {
                iv.setImageBitmap(chosen);
                return iv;
            }
        } catch (Throwable t) {
            Log.w(TAG, "выбранный фон не загружен: " + t.getMessage());
        }
        try {
            // 2. Картинка внутри сборки
            AssetManager am = getAssets();
            Bitmap bmp = BitmapFactory.decodeStream(am.open(BG_ASSET));
            if (bmp != null) {
                iv.setImageBitmap(bmp);
                return iv;
            }
        } catch (Throwable t) {
            Log.w(TAG, "фон тревоги не загружен (" + BG_ASSET + "): " + t.getMessage());
        }
        // Файла нет или он не прочитался — экран всё равно работает, просто
        // на тёмном фоне.
        return null;
    }

    /**
     * Картинка, выбранная пользователем (device-protected хранилище).
     *
     * Декодируется с масштабированием — картинка ужата до ~1080 px по длинной
     * стороне, а на экране она всё равно показывается во весь экран: грузить
     * 8 МБ пикселей ради фона смысла нет. Результат кэшируется — при повторном
     * открытии окна (свайп недотянул, телефон разблокировали) картинка не
     * перечитывается заново.
     */
    private Bitmap loadChosenBackground() {
        String id = AsutpAlarmPlugin.activeAlarmBgId(this);
        if (id == null || id.isEmpty()) return null;
        // Кэш: картинка та же, пока её не сменили
        if (bgCache != null && !bgCache.isRecycled() && id.equals(bgCacheId)) return bgCache;
        File f = AsutpAlarmPlugin.bgFile(this, id);
        if (f == null || !f.exists()) return null;
        try {
            BitmapFactory.Options probe = new BitmapFactory.Options();
            probe.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(f.getAbsolutePath(), probe);
            int sample = 1;
            int longSide = Math.max(probe.outWidth, probe.outHeight);
            int screenLong = Math.max(getResources().getDisplayMetrics().widthPixels,
                    getResources().getDisplayMetrics().heightPixels);
            while (longSide / sample > screenLong) sample *= 2;
            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sample;
            opts.inPreferredConfig = Bitmap.Config.RGB_565;
            Bitmap bmp = BitmapFactory.decodeFile(f.getAbsolutePath(), opts);
            if (bmp == null) {
                Log.w(TAG, "фон не читается: " + f.getAbsolutePath());
                return null;
            }
            if (bgCache != null && !bgCache.isRecycled()) bgCache.recycle();
            bgCache = bmp;
            bgCacheId = id;
            return bmp;
        } catch (Throwable t) {
            Log.w(TAG, "фон тревоги: " + t.getMessage());
            return null;
        }
    }

    /** Кэш фона окна тревоги — картинка одна и та же, пока её не сменили. */
    private static Bitmap bgCache = null;
    private static String bgCacheId = null;

    // ---------- ПОЛЗУНОК ПОДТВЕРЖДЕНИЯ ----------

    private void buildSwipeBar(final int id, final String payload, final int accent) {
        swipeBar = new FrameLayout(this);
        LinearLayout.LayoutParams barLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(64));
        // Ползунок — сразу под названием блока
        barLp.setMargins(dp(4), dp(18), dp(4), dp(6));
        swipeBar.setLayoutParams(barLp);
        swipeBar.setBackground(stripeBackground());
        // Штриховка рисуется под размер полосы — после раскладки
        swipeBar.post(new Runnable() {
            @Override
            public void run() {
                try {
                    swipeBar.setBackground(stripeBitmap(swipeBar.getWidth(), swipeBar.getHeight()));
                } catch (Throwable t) {
                    Log.w(TAG, "штриховка: " + t.getMessage());
                }
            }
        });

        swipeFill = new View(this);
        swipeFill.setBackgroundColor(0x44FF003C);
        swipeBar.addView(swipeFill, new FrameLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT));

        TextView hint = new TextView(this);
        hint.setText("ПОТЯНИ  »  ПРИНЯТЬ");
        hint.setTextColor(C_MUTED);
        hint.setTextSize(13);
        hint.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        hint.setLetterSpacing(0.18f);
        hint.setGravity(Gravity.CENTER);
        swipeBar.addView(hint, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // Бегунок — циановый квадрат со стрелкой «» (как .swipe-thumb в приложении)
        swipeThumb = new TextView(this);
        swipeThumb.setText("»");
        swipeThumb.setTextColor(Color.BLACK);
        swipeThumb.setTextSize(20);
        swipeThumb.setTypeface(Typeface.DEFAULT_BOLD);
        swipeThumb.setGravity(Gravity.CENTER);
        swipeThumb.setBackground(thumbBackground(accent));
        FrameLayout.LayoutParams thLp = new FrameLayout.LayoutParams(dp(48), dp(48));
        thLp.leftMargin = dp(4);
        thLp.topMargin = dp(8);
        swipeThumb.setLayoutParams(thLp);
        swipeBar.addView(swipeThumb);

        swipeBar.setOnTouchListener(new View.OnTouchListener() {
            @Override
            public boolean onTouch(View v, MotionEvent e) {
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        swiping = true;
                        // Обе точки — в одной системе: raw X экрана и смещение
                        // ползунка относительно его начального положения.
                        swipeStartX = e.getRawX();
                        swipeBaseX = swipeThumb.getTranslationX();
                        swipeThumb.animate().cancel();
                        return true;

                    case MotionEvent.ACTION_MOVE:
                        if (!swiping) return false;
                        float x = swipeBaseX + (e.getRawX() - swipeStartX);
                        if (x < 0) x = 0;
                        if (x > swipeMax()) x = swipeMax();
                        swipeThumb.setTranslationX(x);
                        setFillWidth((int) (x + swipeThumb.getWidth() / 2f));
                        return true;

                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL:
                        if (!swiping) return false;
                        swiping = false;
                        if (swipeThumb.getTranslationX() >= swipeMax() * 0.85f) {
                            acknowledge(id, payload);
                        } else {
                            // недотянули — ползунок возвращается на место
                            swipeThumb.animate().translationX(0).setDuration(200)
                                    .withEndAction(new Runnable() {
                                        @Override
                                        public void run() { setFillWidth(0); }
                                    }).start();
                        }
                        return true;
                }
                return false;
            }
        });
    }

    private int swipeMax() {
        int w = swipeBar == null ? 0 : swipeBar.getWidth();
        int t = swipeThumb == null ? 0 : swipeThumb.getWidth();
        return Math.max(10, w - t - dp(8));
    }

    private void setFillWidth(int w) {
        if (swipeFill == null) return;
        ViewGroup.LayoutParams lp = swipeFill.getLayoutParams();
        lp.width = w;
        swipeFill.setLayoutParams(lp);
    }

    // ---------- ОФОРМЛЕНИЕ ----------

    private GradientDrawable solid(int color) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(dp(2));
        return d;
    }

    private GradientDrawable thumbBackground(int accent) {
        GradientDrawable d = new GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                new int[]{0xFF00F0FF, 0xFF05FFA1});
        d.setCornerRadius(dp(2));
        return d;
    }

    /**
     * Рамка экрана тревоги: сплошная красная (или жёлтая для перерыва) обводка
     * по краю экрана + мягкое внутреннее свечение — как .frame в прототипе.
     * Рисуется вручную, потому что у View нет «inset-тени».
     */
    private class FrameView extends View {
        private final Paint border = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint glow = new Paint(Paint.ANTI_ALIAS_FLAG);
        private int accent;
        /** Прозрачность внутреннего свечения — пульсирует. */
        private int glowAlpha = 0x18;
        private boolean glowDim = false;

        FrameView(int accent) {
            super(AsutpAlarmActivity.this);
            this.accent = accent;
            border.setStyle(Paint.Style.STROKE);
            border.setStrokeWidth(dp(4));
            glow.setStyle(Paint.Style.STROKE);
        }

        /** Пульсация внутреннего свечения: ярче → тусклее → ярче. */
        void pulseGlow() {
            glowDim = !glowDim;
            glowAlpha = glowDim ? 0x05 : 0x20;
            invalidate();
            postDelayed(new Runnable() {
                @Override
                public void run() { pulseGlow(); }
            }, 1100);
        }

        @Override
        protected void onDraw(Canvas canvas) {
            int w = getWidth();
            int h = getHeight();
            if (w <= 0 || h <= 0) return;
            // Обводка по краю экрана
            border.setColor(accent);
            float inset = dp(2);
            canvas.drawRect(inset, inset, w - inset, h - inset, border);
            // Внутреннее свечение — несколько вложенных прямоугольников
            glow.setStrokeWidth(dp(10));
            for (int i = 1; i <= 6; i++) {
                int alpha = glowAlpha - i * 0x03;
                if (alpha <= 0) break;
                glow.setColor((alpha << 24) | (accent & 0x00FFFFFF));
                float d = inset + i * dp(9);
                canvas.drawRect(d, d, w - d, h - d, glow);
            }
        }
    }

    /**
     * Подложка блока свайпа: диагональная штриховка по всей площади —
     * как .swipe-box в веб-версии (ярче и шире, чем раньше).
     */
    private android.graphics.drawable.Drawable stripeBackground() {
        GradientDrawable base = new GradientDrawable();
        base.setColor(0xFF06060A);
        base.setStroke(dp(1), 0x6600F0FF);
        return base;
    }

    /**
     * Диагональная штриховка блока свайпа — рисуется прямо в битмап нужного
     * размера (полосы шире и ярче, чем у .swipe-box в веб-версии).
     */
    private android.graphics.drawable.Drawable stripeBitmap(int w, int h) {
        try {
            if (w <= 0 || h <= 0) return stripeBackground();
            Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bmp);
            canvas.drawColor(0xFF06060A);
            Paint paint = new Paint();
            paint.setColor(0x2E00F0FF);
            paint.setStrokeWidth(5f);
            int step = 22;
            for (int x = -h; x < w + h; x += step) {
                canvas.drawLine(x, h, x + h, 0, paint);
            }
            return new android.graphics.drawable.BitmapDrawable(getResources(), bmp);
        } catch (Throwable t) {
            Log.w(TAG, "штриховка: " + t.getMessage());
            return stripeBackground();
        }
    }

    /** Мягкое пульсирующее свечение по краям — аналог alarmFlash. */
    private void pulse(final View v) {
        v.setElevation(0);
        v.post(new Runnable() {
            @Override
            public void run() {
                try {
                    if (v instanceof FrameView) {
                        // У рамки пульсирует только свечение, сама обводка — ровная
                        ((FrameView) v).pulseGlow();
                        return;
                    }
                    Object o = v.getBackground();
                    if (!(o instanceof GradientDrawable)) return;
                    v.animate().alpha(0.55f).setDuration(1100).withEndAction(new Runnable() {
                        @Override
                        public void run() {
                            v.animate().alpha(1f).setDuration(1100).withEndAction(new Runnable() {
                                @Override
                                public void run() { pulse(v); }
                            }).start();
                        }
                    }).start();
                } catch (Throwable t) {
                    Log.w(TAG, "пульсация: " + t.getMessage());
                }
            }
        });
    }

    /** Бегущая сканлайн-полоса — как body::after в веб-версии. */
    private void startScanline(final View line) {
        line.post(new Runnable() {
            @Override
            public void run() {
                try {
                    int h = getResources().getDisplayMetrics().heightPixels;
                    line.setTranslationY(0f);
                    line.animate().translationY(h).setDuration(7000)
                            .withEndAction(new Runnable() {
                                @Override
                                public void run() { startScanline(line); }
                            }).start();
                } catch (Throwable t) {
                    Log.w(TAG, "сканлайн: " + t.getMessage());
                }
            }
        });
    }

    // ---------- ПЕРЕХОД В ПРИЛОЖЕНИЕ И ПОДТВЕРЖДЕНИЕ ----------

    /** Тестовый запуск из настроек: показываем окно, даже если телефон разблокирован. */
    private boolean forceShow() {
        try {
            return getIntent() != null
                    && getIntent().getBooleanExtra(EXTRA_FORCE_SHOW, false);
        } catch (Exception e) {
            return false;
        }
    }

    /** Открыть обычное приложение. false — остаёмся на экране тревоги. */
    private boolean forwardToApp() {
        if (forwarded) return true;
        // Тестовый запуск из настроек: окно показываем поверх всего,
        // не перенаправляя в приложение.
        if (forceShow()) return false;
        // Если экран заблокирован — показываем экран тревоги, а не приложение.
        // Проверять надо именно экран: после перезагрузки MIUI может считать
        // пользователя «разблокированным» (сессия жива), пока экран заблокирован.
        if (isScreenLocked()) return false;
        if (!isUnlocked()) return false;
        forwarded = true;
        try {
            Intent app = new Intent(this, MainActivity.class);
            app.setAction(Intent.ACTION_MAIN);
            app.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_SINGLE_TOP
                    | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            String payload = getIntent() == null ? null
                    : getIntent().getStringExtra(AsutpAlarmReceiver.EXTRA_PAYLOAD);
            if (payload != null) app.putExtra(AsutpAlarmReceiver.EXTRA_PAYLOAD, payload);
            startActivity(app);
        } catch (Exception e) {
            Log.e(TAG, "переход в приложение: " + e.getMessage());
        }
        try {
            finish();
        } catch (Exception e) {
            Log.e(TAG, "finish: " + e.getMessage());
        }
        return true;
    }

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

    /** Подтверждение тревоги: тот же broadcast, что у кнопки «ПРИНЯТО». */
    private void acknowledge(int id, String payload) {
        try {
            Intent ack = new Intent(this, AsutpAlarmReceiver.class);
            ack.setAction(AsutpAlarmReceiver.ACTION_ACK);
            ack.putExtra(AsutpAlarmReceiver.EXTRA_ID, id);
            ack.putExtra(AsutpAlarmReceiver.EXTRA_PAYLOAD, payload);
            sendBroadcast(ack);
        } catch (Exception e) {
            Log.e(TAG, "подтверждение: " + e.getMessage());
        }
        showConfirmed();
        try {
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(
                    new Runnable() {
                        @Override
                        public void run() {
                            try {
                                finish();
                            } catch (Exception e) {
                                Log.e(TAG, "finish: " + e.getMessage());
                            }
                        }
                    }, 900);
        } catch (Exception e) {
            Log.e(TAG, "закрытие: " + e.getMessage());
            try {
                finish();
            } catch (Exception e2) {
                Log.e(TAG, "finish: " + e2.getMessage());
            }
        }
    }

    /** Состояние «подтверждено»: в бейдже — «ПРИНЯТО» в циановом квадрате. */
    private void showConfirmed() {
        try {
            if (badgeView != null) {
                badgeView.setText("ПРИНЯТО");
                badgeView.setBackground(solid(C_CYAN));
            }
            // Полоса свайпа — зелёная, бегунок в конце (как в прототипе)
            if (swipeFill != null) swipeFill.setBackgroundColor(0x5905FFA1);
            if (swipeThumb != null) {
                swipeThumb.animate().cancel();
                swipeThumb.setTranslationX(swipeMax());
            }
            setFillWidth(swipeBar == null ? 0 : swipeBar.getWidth());
        } catch (Exception e) {
            Log.e(TAG, "подтверждено: " + e.getMessage());
        }
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v,
                getResources().getDisplayMetrics());
    }
}
