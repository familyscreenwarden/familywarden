package com.familyscreenwarden.kids

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.provider.Telephony
import android.telephony.SmsManager
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.content.FileProvider
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.add
import com.familyscreenwarden.kids.core.Mms
import com.familyscreenwarden.kids.core.TextRules
import com.familyscreenwarden.kids.core.json
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID

@Serializable data class MediaRef(val id: String, val type: String, val file: String, val up: Boolean = false)

data class Msg(
    val id: String,
    val thread: String,
    /** The other people's numbers, as they came (for sending). */
    val nums: List<String>,
    val dir: String,
    val from: String?,
    val body: String,
    val at: Long,
    val unread: Boolean,
    val media: List<MediaRef>,
    val sent: String,
    val reported: String?,
)

/**
 * The kids' texting app: Family Screen Warden is the phone's texting app (Android's default SMS app), so every text comes
 * here first. Who can text is TextRules (family any time, friends a grown-up said yes to, not at bedtime; strangers
 * held for the grown-ups). Texts are kept on the phone (in storage that works before the phone is unlocked) and a copy
 * of each goes to the server with the sync (photos uploaded after).
 */
object Texts {
    private lateinit var ctx: Context
    private lateinit var db: SQLiteDatabase
    private lateinit var dir: File
    private const val CHANNEL = "texts"
    /** The texts screen, when it's open: told when something changes. */
    var onChange: (() -> Unit)? = null
    private var lastLocked: Boolean? = null

    fun init(context: Context) {
        if (::ctx.isInitialized) return
        ctx = context.applicationContext
        val dp = ctx.createDeviceProtectedStorageContext()
        db = Db(dp).writableDatabase
        dir = File(dp.filesDir, "texts").apply { mkdirs() }
        ctx.getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL, "Texts", NotificationManager.IMPORTANCE_HIGH))
    }

    private class Db(c: Context) : SQLiteOpenHelper(c, "texts.db", null, 1) {
        override fun onCreate(d: SQLiteDatabase) {
            d.execSQL(
                """create table msg (id text primary key, thread text not null, nums text not null, dir text not null, from_num text, body text not null default '',
                   at integer not null, unread integer not null default 0, media text not null default '[]', sent text not null default 'ok', reported text,
                   notified integer not null default 0)""",
            )
            d.execSQL("create index msg_thread on msg (thread, at)")
            d.execSQL("create table pending_mms (tid text primary key, location text not null, nums text not null, tries integer not null default 0, at integer not null)")
        }
        override fun onUpgrade(d: SQLiteDatabase, a: Int, b: Int) {}
    }

    // ------------------------------------------------------------------------------------------------ who
    fun people(): TextRules.People {
        val s = Kids.snap
        return TextRules.People(s?.phone?.contacts ?: emptyList(), s?.texting?.friends ?: emptyList(), s?.texting?.blocked ?: emptyList())
    }
    private fun locked() = runCatching { Kids.lockedNow }.getOrDefault(false)
    fun statusOf(thread: String, p: TextRules.People = people(), locked: Boolean = locked()) = TextRules.status(thread.split(',').filter { it.isNotEmpty() }, p, locked)

    /** The phone's own numbers (left out of group texts' people). */
    private val mine: Set<String> by lazy { ownNumbers() }

    @android.annotation.SuppressLint("MissingPermission", "HardwareIds")
    private fun ownNumbers(): Set<String> {
        val out = HashSet<String>()
        runCatching {
            val sm = ctx.getSystemService(SubscriptionManager::class.java)
            val subs = sm.activeSubscriptionInfoList.orEmpty()
            for (s in subs) {
                val n = if (Build.VERSION.SDK_INT >= 33) sm.getPhoneNumber(s.subscriptionId) else @Suppress("DEPRECATION") s.number
                TextRules.key(n).takeIf { it.length >= 7 }?.let { out += it }
            }
        }
        runCatching { @Suppress("DEPRECATION") TextRules.key(ctx.getSystemService(TelephonyManager::class.java).line1Number).takeIf { it.length >= 7 }?.let { out += it } }
        return out
    }

    // ------------------------------------------------------------------------------------------------ the store
    private fun row(c: android.database.Cursor) = Msg(
        id = c.getString(0), thread = c.getString(1), nums = c.getString(2).split('\n').filter { it.isNotEmpty() }, dir = c.getString(3),
        from = c.getString(4), body = c.getString(5), at = c.getLong(6), unread = c.getInt(7) == 1,
        media = runCatching { json.decodeFromString<List<MediaRef>>(c.getString(8)) }.getOrDefault(emptyList()), sent = c.getString(9), reported = c.getString(10),
    )
    private const val COLS = "id, thread, nums, dir, from_num, body, at, unread, media, sent, reported"
    private fun query(where: String, args: Array<String>, tail: String = "") =
        db.rawQuery("select $COLS from msg where $where $tail", args).use { c -> buildList { while (c.moveToNext()) add(row(c)) } }

    private fun save(m: Msg, notified: Boolean = false) {
        db.insertWithOnConflict("msg", null, ContentValues().apply {
            put("id", m.id); put("thread", m.thread); put("nums", m.nums.joinToString("\n")); put("dir", m.dir); put("from_num", m.from); put("body", m.body)
            put("at", m.at); put("unread", if (m.unread) 1 else 0); put("media", json.encodeToString(m.media)); put("sent", m.sent); put("reported", m.reported)
            put("notified", if (notified) 1 else 0)
        }, SQLiteDatabase.CONFLICT_REPLACE)
    }

    fun thread(t: String) = query("thread = ?", arrayOf(t), "order by at")
    fun markRead(t: String) {
        db.execSQL("update msg set unread = 0 where thread = ?", arrayOf(t))
        ctx.getSystemService(NotificationManager::class.java).cancel(t.hashCode())
    }

    /** The chats: the newest text in each (held and blocked ones aren't shown to the kid). */
    fun chats(): List<Pair<Msg, Int>> {
        val newest = db.rawQuery(
            "select $COLS from msg m where at = (select max(at) from msg where thread = m.thread) group by thread order by at desc limit 200", arrayOf(),
        ).use { c -> buildList { while (c.moveToNext()) add(row(c)) } }
        val unread = HashMap<String, Int>()
        db.rawQuery("select thread, count(*) from msg where unread = 1 group by thread", arrayOf()).use { c -> while (c.moveToNext()) unread[c.getString(0)] = c.getInt(1) }
        return newest.map { it to (unread[it.thread] ?: 0) }
    }

    /** Unread texts the kid can see now (for the launcher's Texts button). */
    fun unreadShown(): Int {
        val p = people(); val l = locked()
        var n = 0
        db.rawQuery("select thread, count(*) from msg where unread = 1 group by thread", arrayOf()).use { c ->
            while (c.moveToNext()) if (statusOf(c.getString(0), p, l) == TextRules.SHOWN) n += c.getInt(1)
        }
        return n
    }

    fun mediaFile(id: String): File? {
        val f = File(dir, id)
        return if (f.canonicalPath.startsWith(dir.canonicalPath) && f.exists()) f else null
    }

    // ------------------------------------------------------------------------------------------------ texts arriving
    /** A plain text (SMS). */
    fun incomingSms(from: String, body: String, at: Long) {
        val k = TextRules.key(from)
        if (k.isEmpty()) return
        val m = Msg(UUID.randomUUID().toString(), k, listOf(from), "in", from, body.take(5000), at, true, emptyList(), "ok", null)
        arrived(m)
        // The old family-texts list on the launcher.
        runCatching { Kids.incomingSms(from, body) }
        // Also in Android's own message store, for anything that reads it (not texts held for the grown-ups).
        if (statusOf(m.thread) == TextRules.SHOWN) runCatching {
            ctx.contentResolver.insert(Telephony.Sms.Inbox.CONTENT_URI, ContentValues().apply { put("address", from); put("body", body); put("date", at); put("read", 0) })
        }
    }

    /** A downloaded picture or group text (MMS). */
    fun incomingMms(m: Mms.Message) {
        val people = (listOf(m.from) + m.to + m.cc).map { Mms.address(it) }.filter { it.isNotEmpty() && TextRules.key(it) !in mine && TextRules.key(it).length >= 3 }
            .distinctBy { TextRules.key(it) }
        if (people.isEmpty()) return
        val media = m.media.take(10).map { p ->
            val id = UUID.randomUUID().toString()
            File(dir, id).writeBytes(p.data)
            MediaRef(id, p.type, id)
        }
        val at = if (m.dateSec > 0) m.dateSec * 1000 else System.currentTimeMillis()
        arrived(Msg(UUID.randomUUID().toString(), TextRules.thread(people), people, "in", m.from, m.text.take(5000), at, true, media, "ok", null))
    }

    private fun arrived(m: Msg) {
        val st = statusOf(m.thread)
        if (st == TextRules.BLOCKED) { m.media.forEach { File(dir, it.file).delete() }; return }
        save(m)
        if (st == TextRules.SHOWN) notify(m)
        changed()
    }

    private fun nameOf(num: String?, p: TextRules.People = people()) = num?.let { p.name(TextRules.key(it)) } ?: num ?: "Someone"
    fun titleOf(thread: String, p: TextRules.People = people()): String {
        val ks = thread.split(',').filter { it.isNotEmpty() }
        val names = ks.map { p.name(it) ?: pretty(it) }
        val fam = p.family.keys
        return when {
            ks.size > 2 && ks.all { it in fam } -> "Family"
            else -> names.joinToString(", ")
        }
    }
    fun pretty(k: String) = if (k.length == 10) "(${k.substring(0, 3)}) ${k.substring(3, 6)}-${k.substring(6)}" else k

    private fun notify(m: Msg) {
        val p = people()
        val who = Person.Builder().setName(nameOf(m.from, p)).build()
        val open = PendingIntent.getActivity(
            ctx, m.thread.hashCode(), Intent(ctx, TextsActivity::class.java).putExtra("thread", m.thread).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val style = NotificationCompat.MessagingStyle(Person.Builder().setName("You").build())
            .setConversationTitle(if (m.thread.contains(',')) titleOf(m.thread, p) else null).setGroupConversation(m.thread.contains(','))
            .addMessage(m.body.ifEmpty { "Photo" }, m.at, who)
        val n = NotificationCompat.Builder(ctx, CHANNEL).setSmallIcon(R.drawable.ic_notify).setStyle(style).setContentIntent(open).setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE).setSilent(Sound.mode == "mute").build()
        runCatching { ctx.getSystemService(NotificationManager::class.java).notify(m.thread.hashCode(), n) }
        db.execSQL("update msg set notified = 1 where id = ?", arrayOf(m.id))
    }

    /** Every second or so (from the clock): when bedtime ends, the friends' texts that waited are told about. */
    fun tick() {
        if (!::ctx.isInitialized) return
        val l = locked()
        if (lastLocked == true && !l) {
            val p = people()
            for (m in query("unread = 1 and notified = 0 and dir = 'in'", arrayOf(), "order by at")) if (statusOf(m.thread, p, false) == TextRules.SHOWN) notify(m)
            changed()
        } else if (lastLocked == false && l) changed()
        lastLocked = l
        retryDownloads()
    }

    private fun changed() { onChange?.invoke(); runCatching { Kids.refreshPage() } }

    // ------------------------------------------------------------------------------------------------ sending
    private fun sms(): SmsManager {
        val sub = SubscriptionManager.getDefaultSmsSubscriptionId()
        val ok = sub != SubscriptionManager.INVALID_SUBSCRIPTION_ID
        return if (Build.VERSION.SDK_INT >= 31) ctx.getSystemService(SmsManager::class.java).let { if (ok) it.createForSubscriptionId(sub) else it }
        else @Suppress("DEPRECATION") if (ok) SmsManager.getSmsManagerForSubscriptionId(sub) else SmsManager.getDefault()
    }

    /** Sends to a chat (its people's numbers). Only when the rules allow it right now. Returns a message for the kid, or null. */
    fun send(nums: List<String>, text: String, photos: List<File>): String? {
        val people = nums.filter { TextRules.key(it).isNotEmpty() }.distinctBy { TextRules.key(it) }
        if (people.isEmpty()) return "Pick who to text."
        val thread = TextRules.thread(people)
        when (statusOf(thread)) {
            TextRules.WAITING -> return "You can text friends again when bedtime or time's up is over."
            TextRules.HELD, TextRules.BLOCKED -> return "You can only text your family and friends a grown-up said yes to."
        }
        val body = text.trim().take(2000)
        if (body.isEmpty() && photos.isEmpty()) return null
        val media = photos.take(5).mapNotNull { f -> shrink(f)?.let { b -> val id = UUID.randomUUID().toString(); File(dir, id).writeBytes(b); MediaRef(id, "image/jpeg", id) } }
        val m = Msg(UUID.randomUUID().toString(), thread, people, "out", null, body, System.currentTimeMillis(), false, media, "sending", null)
        save(m, notified = true)
        changed()
        try {
            if (people.size == 1 && media.isEmpty()) sendSms(m) else sendMms(m)
        } catch (e: Exception) {
            Log.w(Kids.TAG, "send: ${e.message}")
            setSent(m.id, false)
        }
        Kids.syncSoon()
        return null
    }

    fun retry(id: String) {
        val m = query("id = ?", arrayOf(id)).firstOrNull() ?: return
        if (m.dir != "out" || m.sent != "failed") return
        if (statusOf(m.thread) != TextRules.SHOWN) return
        db.execSQL("update msg set sent = 'sending' where id = ?", arrayOf(id))
        changed()
        runCatching { if (m.nums.size == 1 && m.media.isEmpty()) sendSms(m) else sendMms(m) }.onFailure { setSent(id, false) }
    }

    private fun sendSms(m: Msg) {
        val sm = sms()
        val parts = sm.divideMessage(m.body)
        val sent = ArrayList<PendingIntent>()
        parts.forEachIndexed { i, _ ->
            sent += PendingIntent.getBroadcast(
                ctx, (m.id + i).hashCode(), Intent(ctx, TextSentReceiver::class.java).putExtra("id", m.id).putExtra("last", i == parts.size - 1),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }
        sm.sendMultipartTextMessage(Mms.dialable(m.nums[0]), null, parts, sent, null)
        runCatching {
            ctx.contentResolver.insert(Telephony.Sms.Sent.CONTENT_URI, ContentValues().apply { put("address", m.nums[0]); put("body", m.body); put("date", m.at); put("read", 1) })
        }
    }

    private fun sendMms(m: Msg) {
        val parts = m.media.mapNotNull { r -> File(dir, r.file).takeIf { it.exists() }?.let { Mms.Part(r.type, it.readBytes()) } }
        val pdu = Mms.sendReq(m.id.replace("-", "").take(20), m.nums, m.body, parts, System.currentTimeMillis() / 1000)
        val f = File(File(ctx.cacheDir, "mms").apply { mkdirs() }, "send-${m.id}.pdu")
        f.writeBytes(pdu)
        val uri = share(f, write = false)
        val pi = PendingIntent.getBroadcast(
            ctx, m.id.hashCode(), Intent(ctx, TextSentReceiver::class.java).putExtra("id", m.id).putExtra("last", true).putExtra("file", f.path),
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        sms().sendMultimediaMessage(ctx, uri, null, null, pi)
    }

    /** A file Android's phone service can read (sending) or write (downloading) for us. */
    private fun share(f: File, write: Boolean): Uri {
        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.files", f)
        val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or (if (write) Intent.FLAG_GRANT_WRITE_URI_PERMISSION else 0)
        for (p in listOf("com.android.phone", "com.android.mms.service")) runCatching { ctx.grantUriPermission(p, uri, flags) }
        return uri
    }

    fun setSent(id: String, ok: Boolean) {
        db.execSQL("update msg set sent = ? where id = ?", arrayOf(if (ok) "ok" else "failed", id))
        changed()
    }

    /** A photo for a text: at most 1280 px and about 300 KB (what carriers take). */
    private fun shrink(f: File): ByteArray? = runCatching {
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(f.path, o)
        var sample = 1
        while (o.outWidth / sample > 2560 || o.outHeight / sample > 2560) sample *= 2
        var bmp = BitmapFactory.decodeFile(f.path, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
        val rot = runCatching {
            when (android.media.ExifInterface(f.path).getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION, 1)) { 6 -> 90; 3 -> 180; 8 -> 270; else -> 0 }
        }.getOrDefault(0)
        val scale = minOf(1f, 1280f / maxOf(bmp.width, bmp.height))
        val m = android.graphics.Matrix().apply { postScale(scale, scale); postRotate(rot.toFloat()) }
        bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
        var q = 85
        var out: ByteArray
        do {
            out = ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.JPEG, q, it) }.toByteArray()
            q -= 10
        } while (out.size > 300_000 && q > 25)
        out
    }.getOrNull()

    // ------------------------------------------------------------------------------------------------ picture texts arriving
    /** "You have a picture text" (WAP push): download it. */
    fun mmsNotice(pdu: ByteArray) {
        val n = Mms.parse(pdu) ?: return
        if (n.type != Mms.NOTIFICATION_IND || n.contentLocation.isEmpty()) return
        db.insertWithOnConflict("pending_mms", null, ContentValues().apply {
            put("tid", n.transactionId.ifEmpty { n.contentLocation }); put("location", n.contentLocation); put("nums", n.from); put("tries", 0); put("at", System.currentTimeMillis())
        }, SQLiteDatabase.CONFLICT_IGNORE)
        download(n.transactionId.ifEmpty { n.contentLocation }, n.contentLocation)
    }

    private fun download(tid: String, location: String) {
        db.execSQL("update pending_mms set tries = tries + 1, at = ? where tid = ?", arrayOf<Any>(System.currentTimeMillis(), tid))
        val f = File(File(ctx.cacheDir, "mms").apply { mkdirs() }, "dl-${tid.hashCode()}-${System.currentTimeMillis()}.pdu")
        f.createNewFile()
        val uri = share(f, write = true)
        val pi = PendingIntent.getBroadcast(
            ctx, tid.hashCode(), Intent(ctx, MmsDownloadedReceiver::class.java).putExtra("tid", tid).putExtra("file", f.path),
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        runCatching { sms().downloadMultimediaMessage(ctx, location, uri, null, pi) }.onFailure { Log.w(Kids.TAG, "mms download: ${it.message}") }
    }

    fun downloaded(tid: String, file: File, ok: Boolean) {
        val m = if (ok) Mms.parse(runCatching { file.readBytes() }.getOrDefault(ByteArray(0))) else null
        file.delete()
        if (m == null || m.type != Mms.RETRIEVE_CONF) { Log.w(Kids.TAG, "mms download failed ($tid)"); return }
        db.delete("pending_mms", "tid = ?", arrayOf(tid))
        incomingMms(m)
        // "Got it", so the carrier doesn't send the notice again.
        runCatching {
            val f = File(File(ctx.cacheDir, "mms").apply { mkdirs() }, "ack-${tid.hashCode()}.pdu")
            f.writeBytes(Mms.notifyResp(tid))
            sms().sendMultimediaMessage(ctx, share(f, write = false), null, null, null)
        }
    }

    private var retriedAt = 0L
    private fun retryDownloads() {
        val t = System.currentTimeMillis()
        if (t - retriedAt < 60_000) return
        retriedAt = t
        db.delete("pending_mms", "tries >= 6 or at < ?", arrayOf((t - 3 * 86400_000L).toString()))
        db.rawQuery("select tid, location from pending_mms where at < ?", arrayOf((t - 120_000L).toString())).use { c ->
            while (c.moveToNext()) download(c.getString(0), c.getString(1))
        }
    }

    // ------------------------------------------------------------------------------------------------ the server's copy
    /** Texts the server hasn't got yet, or whose status changed (held → shown when a grown-up added the friend). */
    fun toReport(): List<Pair<String, JsonObject>> {
        val p = people()
        val l = locked()
        val out = ArrayList<Pair<String, JsonObject>>()
        for (m in query("reported is null or reported in ('held', 'waiting')", arrayOf(), "order by at limit 200")) {
            val st = if (m.dir == "out") TextRules.SHOWN else statusOf(m.thread, p, l)
            if (st == TextRules.BLOCKED || st == m.reported) continue
            out += st to buildJsonObject {
                put("id", m.id)
                putJsonArray("thread") { m.nums.forEach { add(it) } }
                put("dir", m.dir)
                m.from?.let { put("from", it) }
                put("body", m.body)
                put("at", m.at)
                put("status", st)
                putJsonArray("media") { m.media.forEach { r -> add(buildJsonObject { put("id", r.id); put("type", r.type) }) } }
            }
            if (out.size >= 50) break
        }
        return out
    }

    fun reported(items: List<Pair<String, JsonObject>>) {
        for ((st, o) in items) db.execSQL("update msg set reported = ? where id = ?", arrayOf(st, o["id"].toString().trim('"')))
    }

    /** Photos the server has the text for but not the photo yet. */
    suspend fun uploadMedia(h: WardenApi) {
        for (m in query("reported is not null and media <> '[]'", arrayOf(), "order by at desc limit 200").filter { m -> m.media.any { !it.up } }.take(20)) {
            var changedAny = false
            val list = m.media.map { r ->
                if (r.up) r else {
                    val f = File(dir, r.file)
                    if (!f.exists()) r.copy(up = true).also { changedAny = true } else try {
                        h.upload("android/text-media/${m.id}/${r.id}", f, r.type)
                        changedAny = true
                        r.copy(up = true)
                    } catch (e: WardenApiException) {
                        if (e.reached && e.status in listOf(400, 413, 415)) r.copy(up = true).also { changedAny = true } else return
                    }
                }
            }
            if (changedAny) db.execSQL("update msg set media = ? where id = ?", arrayOf(json.encodeToString(list), m.id))
        }
    }

    /** The sync answer: texts a grown-up deleted, and numbers they blocked, go from the phone. */
    fun applyServer(t: com.familyscreenwarden.kids.core.TextingInfo?) {
        if (t == null || !::ctx.isInitialized) return
        var any = false
        for (id in t.drop) {
            query("id = ?", arrayOf(id)).firstOrNull()?.let { m -> m.media.forEach { File(dir, it.file).delete() }; db.delete("msg", "id = ?", arrayOf(id)); any = true }
        }
        if (t.blocked.isNotEmpty()) {
            val p = people()
            for (m in query("dir = 'in' and (reported is null or reported in ('held', 'waiting'))", arrayOf())) {
                if (statusOf(m.thread, p, false) == TextRules.BLOCKED) { m.media.forEach { File(dir, it.file).delete() }; db.delete("msg", "id = ?", arrayOf(m.id)); any = true }
            }
        }
        if (any) changed()
    }

    /** Someone the kid can text, by number (family, friends). */
    fun contactsDto(): JsonObject {
        val s = Kids.snap
        return buildJsonObject {
            putJsonArray("family") { s?.phone?.contacts?.forEach { c -> add(buildJsonObject { put("name", c.name); put("phone", c.phone); put("key", TextRules.key(c.phone)); put("always", c.always) }) } }
            putJsonArray("friends") { s?.texting?.friends?.forEach { c -> add(buildJsonObject { put("name", c.name); put("phone", c.phone); put("key", TextRules.key(c.phone)) }) } }
            putJsonArray("asked") { s?.texting?.asked?.forEach { c -> add(buildJsonObject { put("name", c.name); put("phone", c.phone); put("key", TextRules.key(c.phone)); put("status", c.status) }) } }
        }
    }
}
