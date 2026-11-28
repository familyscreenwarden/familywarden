package com.familyscreenwarden.kids

import android.annotation.SuppressLint
import android.content.ContentUris
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.util.Size
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
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
import kotlinx.serialization.json.putJsonObject
import kotlinx.serialization.json.add
import com.familyscreenwarden.kids.core.TextRules
import com.familyscreenwarden.kids.core.json
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.util.UUID

/**
 * The kids' texting app's screens (assets/texts: a page in the launcher's look). The chats, a chat, a new text, and
 * "Ask to add a friend". Photos come from the phone's pictures or the camera.
 *
 *  https://app.screenwarden/      the page (assets/texts; /fonts/ is the launcher's bundled fonts)
 *  https://media.screenwarden/id  a photo in a text
 *  https://gallery.screenwarden/n a thumbnail of the phone's picture n (MediaStore)
 *  https://pick.screenwarden/id   a photo picked for the next text
 */
class TextsActivity : ComponentActivity() {
    private lateinit var web: WebView
    private var open: String? = null
    private val picks = HashMap<String, File>()
    private var cameraFile: File? = null

    private val camera = registerForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val f = cameraFile
        if (ok && f != null && f.length() > 0) addPick(f) else f?.delete()
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Kids.init(this)
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
        web.setBackgroundColor(Color.TRANSPARENT)
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse? {
                val u = req.url
                val id = u.path?.trimStart('/').orEmpty()
                return when (u.host) {
                    "app.screenwarden" -> pages.shouldInterceptRequest(u.buildUpon().path(assetPath("texts", u.path)).build())
                    "media.screenwarden" -> Texts.mediaFile(id)?.let { WebResourceResponse("image/jpeg", null, FileInputStream(it)) } ?: notFound()
                    "pick.screenwarden" -> picks[id]?.let { WebResourceResponse("image/jpeg", null, FileInputStream(it)) } ?: notFound()
                    "gallery.screenwarden" -> thumb(id.toLongOrNull())?.let { WebResourceResponse("image/jpeg", null, ByteArrayInputStream(it)) } ?: notFound()
                    else -> null
                }
            }
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest) = req.url.host != "app.screenwarden"
        }
        web.addJavascriptInterface(Bridge(), "ScreenWardenTexts")
        web.loadUrl("https://app.screenwarden/index.html")
        applyLook()
        Texts.onChange = { runOnUiThread { push() } }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { web.evaluateJavascript("window.__back ? window.__back() : false") { r -> if (r != "true") finish() } }
        })
    }

    private fun notFound() = WebResourceResponse("text/plain", "utf-8", 404, "Not found", null, null)

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        start()
    }

    override fun onResume() {
        super.onResume()
        if (::web.isInitialized) applyLook()
        if (::web.isInitialized) push()
    }

    /** Sound and screen: text size, and the app's own brightness when the phone's can't be changed. */
    private fun applyLook() {
        web.settings.textZoom = Sound.textZoom
        window.attributes = window.attributes.apply { screenBrightness = Sound.windowBrightness.let { if (it < 0) -1f else it } }
    }

    override fun onDestroy() {
        Texts.onChange = null
        picks.values.forEach { it.delete() }
        super.onDestroy()
    }

    /** What the notification or another app asked for: a chat, or a new text to some numbers. From the camera
     *  (StudioActivity): photos to send, or a video's link, and the kid picks who ("newText"). */
    private fun start() {
        val t = intent?.getStringExtra("thread")
        val to = intent?.getStringArrayExtra("to")?.toList().orEmpty()
        val text = intent?.getStringExtra("text")
        val photos = intent?.getStringArrayExtra("photos")?.toList().orEmpty()
        val newText = intent?.getBooleanExtra("newText", false) == true || (photos.isNotEmpty() && t == null && to.isEmpty())
        val go = buildJsonObject {
            put("type", "go")
            t?.let { put("thread", it) }
            if (to.isNotEmpty()) put("thread", TextRules.thread(to))
            if (to.isNotEmpty()) putJsonArray("nums") { to.forEach { add(it) } }
            text?.let { put("text", it) }
            if (newText && t == null && to.isEmpty()) put("newText", true)
        }
        send(go)
        intent?.removeExtra("thread"); intent?.removeExtra("to"); intent?.removeExtra("text"); intent?.removeExtra("photos"); intent?.removeExtra("newText")
        if (photos.isNotEmpty()) lifecycleScope.launch {
            val files = withContext(Dispatchers.IO) { photos.take(5).mapNotNull { copyStudioPhoto(it) } }
            files.forEach { addPick(it) }
        }
    }

    /** A copy of one of the kid's camera photos (only those: Studio's folder), so sending can delete it after. */
    private fun copyStudioPhoto(path: String): File? = runCatching {
        Studio.init(this)
        val src = File(path).canonicalFile
        if (!src.path.startsWith(Studio.dir.canonicalPath + File.separator) || !src.isFile) return null
        val f = File(File(cacheDir, "pick").apply { mkdirs() }, "${UUID.randomUUID()}.jpg")
        src.copyTo(f, true)
        f
    }.getOrNull()

    private fun send(o: JsonObject) { web.post { web.evaluateJavascript("window.__texts && window.__texts(${o})", null) } }

    /** The chats and the people (and the open chat). */
    private fun push() {
        val p = Texts.people()
        val st = Kids.statusNow()
        val locked = st.state == "locked"
        val chats = Texts.chats()
        val state = buildJsonObject {
            put("type", "state")
            put("me", Kids.snap?.kid?.name?.split(' ')?.firstOrNull() ?: "")
            put("locked", locked)
            st.lockReason?.let { put("lockReason", it) }
            st.bedtimeUntil?.let { put("until", it) }
            put("contacts", Texts.contactsDto())
            putJsonArray("chats") {
                for ((m, unread) in chats) {
                    val s = Texts.statusOf(m.thread, p, locked)
                    if (s == TextRules.HELD || s == TextRules.BLOCKED) continue
                    add(buildJsonObject {
                        put("thread", m.thread)
                        put("title", Texts.titleOf(m.thread, p))
                        put("status", s)
                        put("unread", unread)
                        put("family", m.thread.split(',').all { it in p.family })
                        putJsonArray("nums") { m.nums.forEach { add(it) } }
                        putJsonArray("people") { m.thread.split(',').forEach { k -> add(buildJsonObject { put("key", k); put("name", p.name(k) ?: Texts.pretty(k)) }) } }
                        putJsonObject("last") {
                            put("dir", m.dir)
                            put("at", m.at)
                            put("body", m.body)
                            put("photo", m.media.isNotEmpty())
                            m.from?.let { f -> put("fromName", p.name(TextRules.key(f)) ?: Texts.pretty(TextRules.key(f))) }
                        }
                    })
                }
            }
            put("held", chats.any { Texts.statusOf(it.first.thread, p, locked) == TextRules.HELD })
            open?.let { t -> put("open", threadDto(t, p, locked)) }
        }
        send(state)
    }

    private fun threadDto(t: String, p: TextRules.People, locked: Boolean) = buildJsonObject {
        val s = Texts.statusOf(t, p, locked)
        put("thread", t)
        put("title", Texts.titleOf(t, p))
        put("status", s)
        putJsonArray("people") { t.split(',').forEach { k -> add(buildJsonObject { put("key", k); put("name", p.name(k) ?: Texts.pretty(k)) }) } }
        putJsonArray("texts") {
            if (s == TextRules.SHOWN) for (m in Texts.thread(t).takeLast(300)) add(buildJsonObject {
                put("id", m.id)
                put("dir", m.dir)
                put("at", m.at)
                put("body", m.body)
                put("sent", m.sent)
                m.from?.let { f -> put("fromName", p.name(TextRules.key(f)) ?: Texts.pretty(TextRules.key(f))) }
                putJsonArray("media") { m.media.forEach { r -> add(buildJsonObject { put("url", "https://media.screenwarden/${r.file}"); put("type", r.type) }) } }
            })
        }
    }

    inner class Bridge {
        @JavascriptInterface fun post(raw: String) { runOnUiThread { command(raw) } }
    }

    private fun command(raw: String) {
        val m = runCatching { json.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return
        fun s(k: String) = (m[k] as? JsonPrimitive)?.content ?: ""
        when (s("cmd")) {
            "hello" -> { push(); start() }
            "open" -> {
                val t = s("thread")
                val st = Texts.statusOf(t)
                if (st != TextRules.SHOWN) { toast(if (st == TextRules.WAITING) waitText() else "You can only text family and friends a grown-up said yes to."); return }
                open = t; Texts.markRead(t); push()
            }
            "close" -> { open = null; push() }
            "send" -> {
                val nums = m["nums"]?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty()
                val files = m["photos"]?.jsonArray?.mapNotNull { picks[it.jsonPrimitive.content] }.orEmpty()
                val text = s("text")
                lifecycleScope.launch {
                    val err = withContext(Dispatchers.IO) { Texts.send(nums, text, files) }
                    if (err != null) toast(err) else {
                        open = TextRules.thread(nums); Texts.markRead(open!!)
                        files.forEach { it.delete() }
                        picks.entries.removeAll { it.value in files }
                        send(buildJsonObject { put("type", "sent") })
                    }
                    push()
                }
            }
            "retry" -> Texts.retry(s("id"))
            "gallery" -> lifecycleScope.launch {
                val ids = withContext(Dispatchers.IO) { gallery() }
                send(buildJsonObject { put("type", "gallery"); putJsonArray("photos") { ids.forEach { add(it) } } })
            }
            "pick" -> lifecycleScope.launch {
                val id = s("id").toLongOrNull() ?: return@launch
                val f = withContext(Dispatchers.IO) { copyPicture(id) } ?: return@launch toast("That picture didn't open.")
                addPick(f)
            }
            "unpick" -> picks.remove(s("id"))?.delete()
            "camera" -> takePicture()
            "ask" -> lifecycleScope.launch {
                val body = buildJsonObject { put("name", s("name").take(60)); put("phone", s("phone").take(30)); s("note").takeIf { it.isNotBlank() }?.let { put("note", it.take(200)) } }
                val msg = try {
                    val r = Kids.api?.post("android/friend", body) ?: return@launch toast("This phone isn't set up yet.")
                    json.parseToJsonElement(r).jsonObject["message"]?.jsonPrimitive?.content ?: "Sent to your grown-ups."
                } catch (e: WardenApiException) { e.message ?: "That didn't send. Try again." }
                send(buildJsonObject { put("type", "asked"); put("message", msg) })
                Kids.syncSoon()
            }
            "call" -> {
                val num = s("num")
                if (Texts.statusOf(TextRules.key(num)) == TextRules.SHOWN) { Calls.dialing(num); Phone.call(this, num) } else toast(waitText())
            }
            "home" -> finish()
        }
    }

    private fun waitText(): String {
        val st = Kids.statusNow()
        return when (st.lockReason) {
            "bedtime" -> "It's bedtime. You can still text family. Friends are back in the morning."
            "time" -> "Time's up for today. You can still text family. Friends are back tomorrow."
            else -> "You can still text family. Friends are back when a grown-up unlocks the phone."
        }
    }

    private fun toast(t: String): Unit = send(buildJsonObject { put("type", "toast"); put("text", t) })

    private fun addPick(f: File) {
        val id = UUID.randomUUID().toString()
        picks[id] = f
        send(buildJsonObject { put("type", "picked"); put("id", id); put("url", "https://pick.screenwarden/$id") })
    }

    /** The phone's newest pictures (needs the photos permission: the device owner grants it). */
    private fun gallery(): List<Long> = runCatching {
        val out = ArrayList<Long>()
        contentResolver.query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, arrayOf(MediaStore.Images.Media._ID), null, null, "${MediaStore.Images.Media.DATE_ADDED} desc")?.use { c ->
            while (c.moveToNext() && out.size < 90) out += c.getLong(0)
        }
        out
    }.getOrDefault(emptyList())

    private fun thumb(id: Long?): ByteArray? {
        id ?: return null
        val uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
        return runCatching {
            val b: Bitmap = if (Build.VERSION.SDK_INT >= 29) contentResolver.loadThumbnail(uri, Size(320, 320), null)
            else @Suppress("DEPRECATION") MediaStore.Images.Thumbnails.getThumbnail(contentResolver, id, MediaStore.Images.Thumbnails.MINI_KIND, null)
            ByteArrayOutputStream().also { b.compress(Bitmap.CompressFormat.JPEG, 80, it) }.toByteArray()
        }.getOrNull()
    }

    private fun copyPicture(id: Long): File? = runCatching {
        val uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
        val f = File(File(cacheDir, "pick").apply { mkdirs() }, "${UUID.randomUUID()}.jpg")
        contentResolver.openInputStream(uri)!!.use { i -> f.outputStream().use { i.copyTo(it) } }
        f
    }.getOrNull()

    private fun takePicture() {
        val i = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
        val pkg = packageManager.queryIntentActivities(i, 0).firstOrNull()?.activityInfo?.packageName
        if (pkg == null) { toast("This phone has no camera app."); return }
        // Lock-task mode only opens allowed apps: the camera is allowed for a couple of minutes.
        Kids.allowCamera(pkg)
        val f = File(File(cacheDir, "camera").apply { mkdirs() }, "${UUID.randomUUID()}.jpg")
        cameraFile = f
        val uri: Uri = FileProvider.getUriForFile(this, "$packageName.files", f)
        web.postDelayed({ runCatching { camera.launch(uri) }.onFailure { toast("The camera didn't open.") } }, 400)
    }
}
