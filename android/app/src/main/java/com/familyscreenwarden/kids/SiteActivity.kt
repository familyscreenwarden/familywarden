package com.familyscreenwarden.kids

import android.annotation.SuppressLint
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.familyscreenwarden.kids.core.WebFilter
import java.time.LocalTime

/**
 * A website tile from the launcher, in a simple browser that only goes where the server allows (the site, its subdomains,
 * and the other websites on the kid's list). Anything else is refused and noted for "Recently blocked" in the parent console.
 */
class SiteActivity : ComponentActivity() {
    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Kids.init(this)
        val host = intent.getStringExtra("host") ?: return finish()
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.parseColor("#04060f")) }
        val bar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(16, 8, 16, 8); setBackgroundColor(Color.parseColor("#070a1c")) }
        // Family Screen Warden colours: outlined buttons on the dark bar.
        fun barButton(label: String, onClick: () -> Unit) = Button(this).apply {
            text = label; isAllCaps = false; setTextColor(Color.parseColor("#eef1fb"))
            background = android.graphics.drawable.GradientDrawable().apply { cornerRadius = 8 * resources.displayMetrics.density; setColor(Color.parseColor("#0e1433")); setStroke(resources.displayMetrics.density.toInt().coerceAtLeast(1), Color.parseColor("#2a3468")) }
            setOnClickListener { onClick() }
        }
        bar.addView(barButton("Home") { finish() })
        bar.addView(barButton("Back") { if (web.canGoBack()) web.goBack() }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = (8 * resources.displayMetrics.density).toInt() })
        bar.addView(TextView(this).apply { text = host; setTextColor(Color.parseColor("#8e9ac0")); textSize = 15f; setPadding(16, 0, 0, 0) })
        root.addView(bar)
        web = WebView(this)
        root.addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        val frame = FrameLayout(this).apply { addView(root) }
        setContentView(frame)
        ViewCompat.setOnApplyWindowInsetsListener(frame) { v, i ->
            val s = i.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(s.left, s.top, s.right, s.bottom); i
        }
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.mediaPlaybackRequiresUserGesture = false
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                val h = req.url.host ?: return true
                if (req.url.scheme !in setOf("http", "https")) return true
                if (allowed(h)) return false
                Kids.siteBlocked(h, notify = false)
                startActivity(BlockedActivity.intent(this@SiteActivity, h))
                return true
            }
        }
        web.loadUrl("https://$host/")
        // Back goes back in the page first, then to the launcher.
        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { if (web.canGoBack()) web.goBack() else finish() }
        })
    }

    /** The kid's sites, or with a filtered web anything that isn't blocked (WebFilter, the same as Chrome and Windows). */
    private fun allowed(host: String): Boolean {
        val s = Kids.snap ?: return false
        return !WebFilter.blocked(host, s.web, s.sites, LocalTime.now())
    }

    override fun onResume() {
        super.onResume()
        // Time's up while the site is open: back to the launcher (which shows the lock screen).
        if (Kids.lockedNow) finish()
        Kids.siteInFront = true
    }

    override fun onPause() { Kids.siteInFront = false; super.onPause() }

}
