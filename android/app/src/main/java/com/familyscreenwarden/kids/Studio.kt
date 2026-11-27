package com.familyscreenwarden.kids

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.util.Log
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import com.familyscreenwarden.kids.core.StudioItem
import com.familyscreenwarden.kids.core.StudioRules
import com.familyscreenwarden.kids.core.json
import java.io.File
import java.util.UUID

/**
 * The kid's photos, videos and movies (Camera, My photos and Movie Maker: StudioActivity). Kept on the phone in
 * studio/ (storage that works before the phone is unlocked, like the texts) with a small list (index.json). Each one
 * goes to the server (grown-ups in the parent console can see them); when the kid deletes one it's hidden here, the server is told, and then the
 * file goes from the phone.
 */
object Studio {
    @Volatile private var ready = false
    lateinit var dir: File; private set
    private lateinit var indexFile: File
    private var items = mutableListOf<StudioItem>()
    private val net = Mutex()
    /** The studio screen, when it's open: told when the list changes. */
    var onChange: (() -> Unit)? = null

    @Synchronized fun init(context: Context) {
        if (ready) return
        dir = File(context.applicationContext.createDeviceProtectedStorageContext().filesDir, "studio").apply { mkdirs() }
        indexFile = File(dir, "index.json")
        items = runCatching { json.decodeFromString<List<StudioItem>>(indexFile.readText()) }.getOrElse { emptyList() }.toMutableList()
        File(dir, "tmp").deleteRecursively()
        ready = true
    }

    fun visible(): List<StudioItem> = synchronized(this) { StudioRules.visible(items) }
    fun item(id: String): StudioItem? = synchronized(this) { items.firstOrNull { it.id == id && !it.deleted } }
    fun file(i: StudioItem) = File(dir, i.file)
    fun thumb(i: StudioItem) = File(dir, "${i.id}.thumb.jpg").takeIf { it.exists() } ?: file(i).takeIf { i.kind == StudioRules.PHOTO }

    private fun save() {
        val tmp = File(indexFile.path + ".tmp")
        tmp.writeText(json.encodeToString(items.toList()))
        tmp.renameTo(indexFile)
    }

    private fun update(id: String, f: (StudioItem) -> StudioItem) = synchronized(this) {
        val i = items.indexOfFirst { it.id == id }
        if (i >= 0) { items[i] = f(items[i]); save() }
    }

    private fun changed() = runCatching { onChange?.invoke() }

    /** A new file for the page to fill (the page sends it in pieces). */
    fun newTemp(): File = File(File(dir, "tmp").apply { mkdirs() }, UUID.randomUUID().toString())

    /** Keeps a finished photo, video or movie (the page's file, and the picture shown in the grid). */
    fun add(kind: String, mime: String, temp: File, title: String?, durationSec: Double, poster: ByteArray?): StudioItem? {
        if (kind !in StudioRules.KINDS || temp.length() == 0L) { temp.delete(); return null }
        val id = UUID.randomUUID().toString()
        val ext = when {
            mime.startsWith("image/") -> "jpg"
            mime.contains("mp4") -> "mp4"
            else -> "webm"
        }
        val f = File(dir, "$id.$ext")
        if (!temp.renameTo(f)) { temp.copyTo(f, true); temp.delete() }
        val item = StudioItem(id, kind, StudioRules.cleanTitle(title, kind), System.currentTimeMillis(), durationSec.coerceIn(0.0, 600.0), f.name, mime.substringBefore(';').ifEmpty { "application/octet-stream" })
        runCatching { makeThumb(item, poster) }.onFailure { Log.w(Kids.TAG, "studio thumb: ${it.message}") }
        synchronized(this) { items += item; save() }
        changed()
        return item
    }

    private fun makeThumb(i: StudioItem, poster: ByteArray?) {
        val out = File(dir, "${i.id}.thumb.jpg")
        val b: Bitmap? = when {
            poster != null && poster.isNotEmpty() -> BitmapFactory.decodeByteArray(poster, 0, poster.size)
            i.kind == StudioRules.PHOTO -> {
                val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeFile(file(i).path, o)
                var s = 1
                while (maxOf(o.outWidth, o.outHeight) / (s * 2) >= 360) s *= 2
                BitmapFactory.decodeFile(file(i).path, BitmapFactory.Options().apply { inSampleSize = s })
            }
            else -> MediaMetadataRetriever().let { r ->
                try { r.setDataSource(file(i).path); r.getFrameAtTime(0) } finally { runCatching { r.release() } }
            }
        }
        b ?: return
        val scale = minOf(1f, 400f / maxOf(b.width, b.height))
        val t = if (scale < 1f) Bitmap.createScaledBitmap(b, (b.width * scale).toInt().coerceAtLeast(1), (b.height * scale).toInt().coerceAtLeast(1), true) else b
        out.outputStream().use { t.compress(Bitmap.CompressFormat.JPEG, 80, it) }
    }

    /** The kid deleted these: hidden now, the server is told with the next upkeep. */
    fun delete(ids: Collection<String>) {
        synchronized(this) {
            for (k in items.indices) if (items[k].id in ids) items[k] = items[k].copy(deleted = true)
            save()
        }
        changed()
    }

    /** Called with the server check-ins: sends new files (oldest first, a few each time) and tells the server about deletions. */
    suspend fun upkeep(h: WardenApi) {
        if (!ready) return
        net.withLock {
            for (i in synchronized(this) { StudioRules.pendingUploads(items, 3) }) {
                if (!upload(h, i)) break
            }
            for (i in synchronized(this) { StudioRules.pendingDeletes(items) }) {
                if (!i.uploaded) { update(i.id) { it.copy(deleteReported = true) }; continue }
                try {
                    h.post("android/media/${i.id}/deleted", JsonObject(emptyMap()))
                    update(i.id) { it.copy(deleteReported = true) }
                } catch (e: WardenApiException) {
                    if (e.reached && e.status == 404) update(i.id) { it.copy(deleteReported = true) } else break
                }
            }
            purge()
        }
    }

    private fun purge() {
        val gone = synchronized(this) { StudioRules.purgeable(items).also { g -> items.removeAll { it in g }; if (g.isNotEmpty()) save() } }
        for (i in gone) { file(i).delete(); File(dir, "${i.id}.thumb.jpg").delete() }
    }

    /** One file to the server (the raw file as the body). False = stop for now (the server isn't there, or said no). */
    private suspend fun upload(h: WardenApi, i: StudioItem): Boolean {
        val f = file(i)
        if (!f.exists()) { update(i.id) { it.copy(upFailed = true) }; return true }
        return try {
            val code = h.sendFile("android/media", f, StudioRules.uploadHeaders(i))
            val next = StudioRules.afterUpload(i, code)
            if (next != null) update(i.id) { next }
            next != null
        } catch (e: WardenApiException) {
            Log.w(Kids.TAG, "studio upload: ${e.message}")
            false
        }
    }

    /** A link the family can open (served by the server; for videos and movies: too big for a picture text). */
    suspend fun shareLink(id: String): String {
        val h = Kids.api ?: throw WardenApiException("This phone isn't set up yet.", null, false)
        val i = item(id) ?: throw WardenApiException("That video is gone.", null, true)
        i.shareLink?.let { return it }
        suspend fun ask(): String {
            val r = h.post("android/media/$id/link", JsonObject(emptyMap()))
            return json.parseToJsonElement(r).jsonObject["link"]?.jsonPrimitive?.content ?: throw WardenApiException("Family Screen Warden didn't make a link.", null, true)
        }
        val link = try {
            if (!i.uploaded) sendNow(h, id)
            ask()
        } catch (e: WardenApiException) {
            if (e.reached && e.status == 404) {
                update(id) { it.copy(uploaded = false, upFailed = false) }
                sendNow(h, id)
                ask()
            } else throw e
        }
        update(id) { it.copy(shareLink = link) }
        return link
    }

    private suspend fun sendNow(h: WardenApi, id: String) {
        net.withLock {
            val i = synchronized(this) { items.firstOrNull { it.id == id } } ?: return
            if (i.uploaded) return
            upload(h, i)
            val after = synchronized(this) { items.firstOrNull { it.id == id } }
            if (after?.upFailed == true) throw WardenApiException("That video is too big to send.", 413, true)
            if (after?.uploaded != true) throw WardenApiException("Can't reach Family Screen Warden. Try again soon.", null, false)
        }
    }

    /** Asks the server to show a movie on the family screen. Returns the server's words for the kid. */
    suspend fun familyScreen(id: String): String {
        val h = Kids.api ?: return "This phone isn't set up yet."
        return try {
            if (item(id)?.uploaded != true) sendNow(h, id)
            val r = try { h.post("android/media/$id/family-screen", JsonObject(emptyMap())) } catch (e: WardenApiException) {
                if (e.reached && e.status == 404) { update(id) { it.copy(uploaded = false, upFailed = false) }; sendNow(h, id); h.post("android/media/$id/family-screen", JsonObject(emptyMap())) } else throw e
            }
            json.parseToJsonElement(r).jsonObject["message"]?.jsonPrimitive?.content ?: "Sent to the family screen."
        } catch (e: WardenApiException) { e.message ?: "That didn't work. Try again." }
    }
}
