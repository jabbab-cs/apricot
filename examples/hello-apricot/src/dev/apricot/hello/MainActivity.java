package dev.apricot.hello;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Tiny test app for Apricot: exercises taps, typing and logcat. Built without Gradle (see build.sh). */
public class MainActivity extends Activity {
    private static final String TAG = "HelloApricot";
    private int taps = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Log.i(TAG, "onCreate");

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(dp(32), dp(32), dp(32), dp(32));
        root.setBackgroundColor(Color.parseColor("#FFF6EE"));

        TextView title = new TextView(this);
        title.setText("Hello from Android 👋");
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 28);
        title.setTextColor(Color.parseColor("#1D1B19"));
        title.setGravity(Gravity.CENTER);
        root.addView(title);

        TextView subtitle = new TextView(this);
        subtitle.setText("Running on your iPhone via Apricot");
        subtitle.setTextColor(Color.parseColor("#7B736B"));
        subtitle.setGravity(Gravity.CENTER);
        subtitle.setPadding(0, dp(8), 0, dp(28));
        root.addView(subtitle);

        final Button button = new Button(this);
        button.setText("Tap me");
        button.setTextColor(Color.WHITE);
        button.setAllCaps(false);
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        GradientDrawable bg = new GradientDrawable(
                GradientDrawable.Orientation.TL_BR, new int[] {Color.parseColor("#FFB45E"), Color.parseColor("#FF5C3A")});
        bg.setCornerRadius(dp(28));
        button.setBackground(bg);
        button.setOnClickListener(v -> {
            taps++;
            button.setText("Tapped " + taps + (taps == 1 ? " time" : " times"));
            Log.i(TAG, "tap #" + taps);
        });
        root.addView(button, new LinearLayout.LayoutParams(dp(240), dp(56)));

        EditText input = new EditText(this);
        input.setHint("Type something…");
        input.setSingleLine(true);
        LinearLayout.LayoutParams inputParams = new LinearLayout.LayoutParams(dp(280), LinearLayout.LayoutParams.WRAP_CONTENT);
        inputParams.topMargin = dp(28);
        root.addView(input, inputParams);

        final TextView echo = new TextView(this);
        echo.setTextColor(Color.parseColor("#FF5C3A"));
        echo.setPadding(0, dp(12), 0, 0);
        root.addView(echo);
        input.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) {}
            @Override public void afterTextChanged(Editable s) {
                echo.setText(s.length() == 0 ? "" : "You typed: " + s);
                Log.d(TAG, "text: " + s);
            }
        });

        setContentView(root);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
