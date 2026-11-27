package com.familyscreenwarden.kids

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.util.Base64
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebViewAssetLoader
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.add
import com.familyscreenwarden.kids.core.StudioItem
import com.familyscreenwarden.kids.core.StudioRules
import com.familyscreenwarden.kids.core.json
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.FilterInputStream
import java.io.InputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * The kids' Camera, My photos and Movie Maker (assets/studio: a page in the launcher's look). The camera runs in the
 * page (getUserMedia); photos, videos and movies come back in pieces and are kept by Studio.
 * Start it with putExtra("mode", "camera" | "photos" | "movie").
 *
 *  https://app.screenwarden/              the page (assets/studio; /fonts/ is the launcher's bundled fonts)
 *  https://studio-media.screenwarden/id   a photo or video (with Range, so videos can skip around)
 *  https://studio-media.screenwarden/id/thumb   its little picture
 */
class StudioActivity : ComponentActivity() {
    private lateinit var web: WebView
    private var permAsk: PermissionRequest? = null
    private val uploads = ConcurrentHashMap<String, Pair<File, FileOutputStream>>()
    private var wasLocked: Boolean? = null

    private val perms = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { _ ->
        val r = permAsk ?: return@registerForActivityResult
        permAsk = null
        val ok = r.resources.filter { held(it) }
        if (ok.isEmpty()) r.deny() else r.grant(ok.toTypedArray())
    }

    private val tick = object : Runnable {
        override fun run() {
            val locked = Kids.statusNow().state == "locked"
            if (locked != wasLocked) push()
            web.postDelayed(this, 10_000)
        }
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Kids.init(this)
        Studio.init(this)
        if (!Kids.paired) { finish(); return }
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
        val pages = WebViewAssetLoader.Builder().setDomain("app.screenwarden").addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = false
        web.settings.mediaPlaybackRequiresUserGesture = false
        web.setBackgroundColor(Color.TRANSPARENT)
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse? {
                val u = req.url
                return when (u.host) {
                    "app.screenwarden" -> pages.shouldInterceptRequest(u.buildUpon().path(assetPath("studio", u.path)).build())
                    "studio-media.screenwarden" -> media(u.pathSegments.orEmpty(), req.requestHeaders?.entries?.firstOrNull { it.key.equals("Range", true) }?.value)
                    else -> null
                }
            }
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest) = req.url.host != "app.screenwarden"
        }
        web.webChromeClient = object : WebChromeClient() {
            // The camera and microphone for the page: only from our own page, and only if the phone lets this app use them.
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    if (request.origin?.host != "app.screenwarden") { request.deny(); return@runOnUiThread }
                    val want = request.resources.filter { it == PermissionRequest.RESOURCE_VIDEO_CAPTURE || it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }
                    if (want.isEmpty()) { request.deny(); return@runOnUiThread }
                    val missing = want.map(::androidPerm).filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
                    if (missing.isEmpty()) request.grant(want.toTypedArray())
                    else { permAsk?.deny(); permAsk = request; perms.launch(missing.toTypedArray()) }
                }
            }
        }
        web.addJavascriptInterface(Bridge(), "ScreenWardenStudio")
        web.loadUrl("https://app.screenwarden/index.html")
        Studio.onChange = { runOnUiThread { push() } }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { web.evaluateJavascript("window.__back ? window.__back() : false") { r -> if (r != "true") finish() } }
        })
    }

    private fun androidPerm(res: String) = if (res == PermissionRequest.RESOURCE_VIDEO_CAPTURE) Manifest.permission.CAMERA else Manifest.permission.RECORD_AUDIO
    private fun held(res: String) = checkSelfPermission(androidPerm(res)) == PackageManager.PERMISSION_GRANTED

    private fun notFound() = WebResourceResponse("text/plain", "utf-8", 404, "Not found", mapOf("Access-Control-Allow-Origin" to "*"), null)

    /** A file for the page. Videos are asked for in parts (Range) when the kid skips around. */
    private fun media(path: List<String>, rangeHeader: String?): WebResourceResponse {
        val item = path.firstOrNull()?.let { Studio.item(it) } ?: return notFound()
        val thumb = path.getOrNull(1) == "thumb"
        val f = (if (thumb) Studio.thumb(item) else Studio.file(item))?.takeIf { it.exists() } ?: return notFound()
        val mime = if (thumb) "image/jpeg" else item.mime
        val size = f.length()
        val h = mutableMapOf("Access-Control-Allow-Origin" to "*", "Accept-Ranges" to "bytes", "Cache-Control" to "no-cache")
        return when (val r = if (thumb) null else StudioRules.range(rangeHeader, size)) {
            null -> { h["Content-Length"] = size.toString(); WebResourceResponse(mime, null, 200, "OK", h, FileInputStream(f)) }
            is StudioRules.Range.Unsatisfiable -> { h["Content-Range"] = "bytes */$size"; WebResourceResponse(mime, null, 416, "Range Not Satisfiable", h, null) }
            is StudioRules.Range.Part -> {
                h["Content-Range"] = "bytes ${r.start}-${r.end}/$size"
                h["Content-Length"] = r.length.toString()
                val s = FileInputStream(f)
                s.channel.position(r.start)
                WebResourceResponse(mime, null, 206, "Partial Content", h, Limited(s, r.length))
            }
        }
    }

    /** At most [left] bytes of a stream (one Range part). */
    private class Limited(s: InputStream, private var left: Long) : FilterInputStream(s) {
        override fun read(): Int = if (left <= 0) -1 else super.read().also { if (it >= 0) left-- }
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (left <= 0) return -1
            val n = super.read(b, off, minOf(len.toLong(), left).toInt())
            if (n > 0) left -= n
            return n
        }
        override fun available() = minOf(super.available().toLong(), left).toInt()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        start()
    }

    override fun onResume() {
        super.onResume()
        if (!::web.isInitialized) return
        web.onResume()
        // Sound and screen: text size, and the app's own brightness when the phone's can't be changed.
        web.settings.textZoom = Sound.textZoom
        window.attributes = window.attributes.apply { screenBrightness = Sound.windowBrightness.let { if (it < 0) -1f else it } }
        push()
        web.removeCallbacks(tick)
        web.postDelayed(tick, 10_000)
        web.evaluateJavascript("window.__resume && window.__resume()", null)
    }

    override fun onPause() {
        if (::web.isInitialized) {
            web.removeCallbacks(tick)
            web.evaluateJavascript("window.__pause && window.__pause()", null)
            web.onPause()
        }
        super.onPause()
    }

    override fun onDestroy() {
        Studio.onChange = null
        permAsk?.deny()
        uploads.values.forEach { (f, o) -> runCatching { o.close() }; f.delete() }
        uploads.clear()
        if (::web.isInitialized) web.destroy()
        super.onDestroy()
    }

    /** Which screen the launcher asked for. */
    private fun start() {
        val mode = intent?.getStringExtra("mode")?.takeIf { it in setOf("camera", "photos", "movie") } ?: "camera"
        send(buildJsonObject { put("type", "go"); put("mode", mode) })
    }

    private fun send(o: JsonObject) { web.post { web.evaluateJavascript("window.__studio && window.__studio(${o})", null) } }

    private fun itemDto(i: StudioItem) = buildJsonObject {
        put("id", i.id)
        put("kind", i.kind)
        put("title", i.title)
        put("at", i.at)
        put("dur", i.durationSec)
        put("mime", i.mime)
        put("url", "https://studio-media.screenwarden/${i.id}")
        put("thumb", "https://studio-media.screenwarden/${i.id}/thumb")
    }

    /** The kid's photos and videos, and whether the camera is closed right now (bedtime, time's up). */
    private fun push() {
        val st = Kids.statusNow()
        val locked = st.state == "locked"
        wasLocked = locked
        send(buildJsonObject {
            put("type", "state")
            put("me", Kids.snap?.kid?.name?.split(' ')?.firstOrNull() ?: "")
            put("locked", locked)
            st.lockReason?.let { put("lockReason", it) }
            st.bedtimeUntil?.let { put("until", it) }
            putJsonArray("items") { Studio.visible().forEach { add(itemDto(it)) } }
        })
    }

    inner class Bridge {
        @JavascriptInterface fun post(raw: String) { runOnUiThread { command(raw) } }

        /** A new photo, video or movie is coming in pieces: returns its upload id. */
        @JavascriptInterface fun begin(): String {
            if (uploads.size > 4) return ""
            val f = Studio.newTemp()
            val id = UUID.randomUUID().toString()
            uploads[id] = f to FileOutputStream(f)
            return id
        }

        /** One piece (base64, about 512 KB). False = stop (too big, or it went wrong). */
        @JavascriptInterface fun chunk(id: String, b64: String): Boolean {
            val (f, o) = uploads[id] ?: return false
            return try {
                o.write(Base64.decode(b64, Base64.DEFAULT))
                if (f.length() > MAX_BYTES) { cancel(id); false } else true
            } catch (e: Exception) { cancel(id); false }
        }

        @JavascriptInterface fun cancel(id: String) { uploads.remove(id)?.let { (f, o) -> runCatching { o.close() }; f.delete() } }

        /** The last piece came: keeps it. meta = {kind, mime, title, dur, poster (base64 jpeg)}. Returns the new item, or "". */
        @JavascriptInterface fun finish(id: String, meta: String): String {
            val (f, o) = uploads.remove(id) ?: return ""
            runCatching { o.close() }
            val m = runCatching { json.parseToJsonElement(meta).jsonObject }.getOrNull() ?: run { f.delete(); return "" }
            fun s(k: String) = (m[k] as? JsonPrimitive)?.content
            val poster = s("poster")?.let { p -> runCatching { Base64.decode(p.substringAfter(","), Base64.DEFAULT) }.getOrNull() }
            val item = Studio.add(s("kind") ?: "", s("mime") ?: "", f, s("title"), s("dur")?.toDoubleOrNull() ?: 0.0, poster) ?: return ""
            Kids.api?.let { h -> lifecycleScope.launch(Dispatchers.IO) { runCatching { Studio.upkeep(h) } } }
            return itemDto(item).toString()
        }
    }

    private fun command(raw: String) {
        val m = runCatching { json.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return
        fun s(k: String) = (m[k] as? JsonPrimitive)?.content ?: ""
        fun ids() = m["ids"]?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty()
        when (s("cmd")) {
            "hello" -> { push(); start() }
            "home" -> finish()
            "awake" -> if (s("on") == "true") window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            "delete" -> { Studio.delete(ids()); Kids.syncSoon() }
            "texts" -> sendInTexts(ids())
            "familyScreen" -> lifecycleScope.launch {
                val msg = Studio.familyScreen(s("id"))
                send(buildJsonObject { put("type", "familyScreen"); put("message", msg) })
            }
        }
    }

    /** Photos go to Texts as picture texts; videos and movies as a link (picture texts can't carry them). */
    private fun sendInTexts(ids: List<String>) {
        val chosen = ids.mapNotNull { Studio.item(it) }
        if (chosen.isEmpty()) return
        val photos = chosen.filter { it.kind == StudioRules.PHOTO }.take(5).map { Studio.file(it).path }
        val videos = chosen.filter { it.kind != StudioRules.PHOTO }
        lifecycleScope.launch {
            val links = ArrayList<String>()
            if (videos.isNotEmpty()) {
                toast("Getting your video ready…")
                for (v in videos.take(5)) {
                    try { links += withContext(Dispatchers.IO) { Studio.shareLink(v.id) } } catch (e: WardenApiException) {
                        toast(if (e.reached) e.message ?: "That didn't work." else "Can't reach Family Screen Warden right now. Try again soon.")
                        send(buildJsonObject { put("type", "sent") })
                        return@launch
                    }
                }
            }
            val i = Intent(this@StudioActivity, TextsActivity::class.java).putExtra("newText", true)
            if (photos.isNotEmpty()) i.putExtra("photos", photos.toTypedArray())
            if (links.isNotEmpty()) i.putExtra("text", StudioRules.shareText(Kids.snap?.kid?.name, if (videos.all { it.kind == StudioRules.VIDEO }) StudioRules.VIDEO else StudioRules.MOVIE, links))
            send(buildJsonObject { put("type", "sent") })
            startActivity(i)
        }
    }

    private fun toast(t: String): Unit = send(buildJsonObject { put("type", "toast"); put("text", t) })

    companion object {
        /** A movie is at most 3 minutes; this is plenty for that. */
        const val MAX_BYTES = 300L * 1024 * 1024
    }
}

/**
 * Where a page's file sits in the app's assets. Each screen's page has its own folder (launcher, texts, studio);
 * /fonts/ is shared: the bundled fonts in the launcher's folder, so the pages load nothing from the internet.
 */
internal fun assetPath(folder: String, path: String?): String {
    val p = path ?: "/"
    return if (p.startsWith("/fonts/")) "/launcher$p" else "/$folder$p"
}
