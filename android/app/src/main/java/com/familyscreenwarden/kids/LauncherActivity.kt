package com.familyscreenwarden.kids

import android.annotation.SuppressLint
import android.app.ActivityManager
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import java.io.File
import java.io.FileInputStream

/**
 * The kid's home screen: the Family Screen Warden launcher (the same page as on Windows, index.html?phone), with the bar along
 * the bottom, the lock screen and family calls. The app is the phone's only home screen and runs in Android's
 * lock-task mode, so only the apps Family Screen Warden allows can open.
 */
class LauncherActivity : ComponentActivity() {
    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Kids.init(this)
        KidsService.start(this)
        if (!Kids.paired) { startActivity(Intent(this, SetupActivity::class.java)); finish(); return }
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        val frame = FrameLayout(this).apply { setBackgroundColor(Color.parseColor("#04060f")) }
        web = WebView(this)
        frame.addView(web)
        setContentView(frame)
        ViewCompat.setOnApplyWindowInsetsListener(frame) { v, i ->
            val s = i.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(s.left, s.top, s.right, s.bottom); i
        }

        // https://app.screenwarden/ = the launcher files in the app; https://cache.screenwarden/ = app icons saved on the phone.
        val cache = File(cacheDir, "launcher")
        val pages = WebViewAssetLoader.Builder().setDomain("app.screenwarden").addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = false
        web.setBackgroundColor(Color.TRANSPARENT)
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse? {
                val u = req.url
                if (u.host == "cache.screenwarden") {
                    val f = File(cache, u.path?.trimStart('/') ?: return null)
                    if (!f.canonicalPath.startsWith(cache.canonicalPath) || !f.exists()) return WebResourceResponse("text/plain", "utf-8", 404, "Not found", null, null)
                    val type = if (f.name.endsWith(".png")) "image/png" else "application/octet-stream"
                    return WebResourceResponse(type, null, 200, "OK", mapOf("Access-Control-Allow-Origin" to "*"), FileInputStream(f))
                }
                if (u.host == "app.screenwarden") return pages.shouldInterceptRequest(u.buildUpon().path("/launcher" + (u.path ?: "/")).build())
                return null
            }
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest) = req.url.host != "app.screenwarden"
        }
        // The page talks to window.chrome.webview (WebView2 on Windows): the same calls, carried by this bridge.
        web.addJavascriptInterface(Bridge(), "ScreenWardenAndroid")
        web.loadUrl("https://app.screenwarden/index.html?phone")
        Kids.page = { msg -> web.post { web.evaluateJavascript("window.__swReceive && window.__swReceive($msg)", null) } }
        // During a call the launcher (with Answer / Hang up) may show over the phone's lock screen; never otherwise.
        Kids.onCall = { on -> runOnUiThread { setShowWhenLocked(on); setTurnScreenOn(on) } }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { web.evaluateJavascript("document.querySelector('.ov.show') && document.querySelector('[data-close]')?.click()", null) }
        })
    }

    inner class Bridge {
        @JavascriptInterface fun post(msg: String) { Kids.command(msg) }
    }

    override fun onResume() {
        super.onResume()
        Kids.atHome()
        if (!::web.isInitialized) return
        // Lock-task mode: the home screen can't be left for apps that aren't allowed.
        val am = getSystemService(ActivityManager::class.java)
        if (Kids.policy.isOwner && Kids.snap?.watchOnly != true && am.lockTaskModeState == ActivityManager.LOCK_TASK_MODE_NONE) {
            runCatching { startLockTask() }.onFailure { Log.w(Kids.TAG, "lock task: ${it.message}") }
        }
        web.evaluateJavascript("window.__swReceive && window.dispatchEvent(new Event('focus'))", null)
    }

    override fun onDestroy() {
        if (::web.isInitialized) { Kids.page = null; Kids.onCall = null }
        super.onDestroy()
    }
}
