package com.familyscreenwarden.kids

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.RingtoneManager
import android.os.BatteryManager
import android.os.Build
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.coroutines.resume

/**
 * Where the phone is, for the live map in the parent console.
 *  - every 5 minutes a fix goes to the server (a cheap one: network or the last known, GPS only when needed)
 *  - "live" (a grown-up has the map open, or the kid asked to be picked up / for help): GPS every 5 seconds
 *  - Check in from the Phone menu, and Ring phone (loud for 30 seconds, even on mute)
 * The kid always sees that sharing is on (the Phone menu says so). Uses Android's own location (no Google services).
 */
@SuppressLint("StaticFieldLeak")
object Where {
    private lateinit var ctx: Context
    private val lm by lazy { ctx.getSystemService(LocationManager::class.java) }
    private val main = Handler(Looper.getMainLooper())
    private const val EVERY_MS = 5 * 60_000L
    private const val LIVE_MS = 5_000L

    @Volatile private var liveFromServer = false
    @Volatile private var liveUntilMs = 0L
    private var lastSentMs = 0L
    private var listening = false
    private val pending = mutableListOf<Location>()
    private var lastRing: String? = null

    fun init(c: Context) {
        if (::ctx.isInitialized) return
        ctx = c.applicationContext
        lastRing = ctx.getSharedPreferences("where", Context.MODE_PRIVATE).getString("ring", null)
    }

    fun allowed(): Boolean = ::ctx.isInitialized && ctx.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
    private fun sharing() = Kids.snap?.location?.sharing != false
    private fun live() = sharing() && (liveFromServer || Kids.snap?.location?.live == true || System.currentTimeMillis() < liveUntilMs)

    /** "Please come get me" / "I need help now": share live for a while even before the server says so. */
    fun goLive(ms: Long) { liveUntilMs = System.currentTimeMillis() + ms }

    /** Every 5 seconds (Kids' loop): live updates on or off, a fix every 5 minutes, and sending what's waiting. */
    suspend fun step(h: WardenApi?) {
        if (h == null || !allowed()) return
        if (!sharing()) { stopLive(); synchronized(pending) { pending.clear() }; return }
        if (live()) startLive() else stopLive()
        val t = System.currentTimeMillis()
        if (!listening && t - lastSentMs >= EVERY_MS) current(false)?.let { synchronized(pending) { pending += it } }
        val batch = synchronized(pending) { pending.toList().also { pending.clear() } }
        if (batch.isEmpty()) return
        if (listening && t - lastSentMs < LIVE_MS - 500) { synchronized(pending) { pending.addAll(0, batch) }; return }
        try {
            val text = h.post("android/location", buildJsonObject {
                put("fixes", buildJsonArray { batch.takeLast(30).forEach { add(fixJson(it)) } })
            })
            lastSentMs = t
            liveFromServer = runCatching { com.familyscreenwarden.kids.core.json.parseToJsonElement(text).jsonObject["live"]?.jsonPrimitive?.content == "true" }.getOrDefault(false)
        } catch (e: Exception) {
            // Offline: keep a few to send later.
            synchronized(pending) { pending.addAll(0, batch.takeLast(10)); while (pending.size > 30) pending.removeAt(0) }
        }
    }

    private fun fixJson(l: Location) = buildJsonObject {
        put("lat", l.latitude); put("lng", l.longitude)
        if (l.hasAccuracy()) put("accuracy", l.accuracy.toDouble())
        put("at", java.time.Instant.ofEpochMilli(l.time).toString())
        val bm = ctx.getSystemService(BatteryManager::class.java)
        put("battery", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY).coerceIn(0, 100))
        put("charging", bm.isCharging)
    }

    private val listener = LocationListener { l -> synchronized(pending) { pending += l; while (pending.size > 30) pending.removeAt(0) } }

    @SuppressLint("MissingPermission")
    private fun startLive() {
        if (listening) return
        val p = provider(true) ?: return
        runCatching { lm.requestLocationUpdates(p, LIVE_MS, 0f, listener, Looper.getMainLooper()); listening = true }
            .onFailure { Log.w(Kids.TAG, "live location: ${it.message}") }
    }

    private fun stopLive() {
        if (!listening) return
        runCatching { lm.removeUpdates(listener) }
        listening = false
    }

    private fun provider(precise: Boolean): String? {
        val ps = runCatching { lm.getProviders(true) }.getOrDefault(emptyList())
        if (Build.VERSION.SDK_INT >= 31 && LocationManager.FUSED_PROVIDER in ps) return LocationManager.FUSED_PROVIDER
        return when {
            precise && LocationManager.GPS_PROVIDER in ps -> LocationManager.GPS_PROVIDER
            LocationManager.NETWORK_PROVIDER in ps -> LocationManager.NETWORK_PROVIDER
            LocationManager.GPS_PROVIDER in ps -> LocationManager.GPS_PROVIDER
            else -> null
        }
    }

    /** A fix now: the last known one if it's fresh and good, else a new one (up to 20 seconds). */
    @SuppressLint("MissingPermission")
    suspend fun current(precise: Boolean): Location? {
        if (!allowed()) return null
        val best = runCatching { lm.getProviders(true).mapNotNull { lm.getLastKnownLocation(it) }.maxByOrNull { it.time } }.getOrNull()
        val freshMs = if (precise) 30_000L else 4 * 60_000L
        if (best != null && System.currentTimeMillis() - best.time < freshMs && (!best.hasAccuracy() || best.accuracy < (if (precise) 50f else 200f))) return best
        val p = provider(precise) ?: return best
        val got = withTimeoutOrNull(20_000) {
            suspendCancellableCoroutine<Location?> { cont ->
                if (Build.VERSION.SDK_INT >= 30) {
                    val cancel = CancellationSignal()
                    cont.invokeOnCancellation { cancel.cancel() }
                    runCatching { lm.getCurrentLocation(p, cancel, ctx.mainExecutor) { l -> if (cont.isActive) cont.resume(l) } }.onFailure { if (cont.isActive) cont.resume(null) }
                } else {
                    val one = object : LocationListener {
                        override fun onLocationChanged(l: Location) { runCatching { lm.removeUpdates(this) }; if (cont.isActive) cont.resume(l) }
                    }
                    cont.invokeOnCancellation { runCatching { lm.removeUpdates(one) } }
                    @Suppress("DEPRECATION")
                    runCatching { lm.requestSingleUpdate(p, one, Looper.getMainLooper()) }.onFailure { if (cont.isActive) cont.resume(null) }
                }
            }
        }
        return got ?: best
    }

    // ---------------------------------------------------------------- check in
    /** The Phone menu's Check in: ok | pickup | help. Returns the message for the kid. */
    suspend fun checkIn(h: WardenApi?, kind: String): String {
        if (h == null) return "This phone isn't set up yet."
        if (kind != "ok") goLive(30 * 60_000L)
        val l = current(true)
        return try {
            val r = h.post("android/checkin", buildJsonObject {
                put("kind", kind)
                l?.let { put("lat", it.latitude); put("lng", it.longitude); if (it.hasAccuracy()) put("accuracy", it.accuracy.toDouble()) }
            })
            com.familyscreenwarden.kids.core.json.parseToJsonElement(r).jsonObject["message"]?.jsonPrimitive?.content ?: "Sent."
        } catch (e: WardenApiException) {
            if (e.reached) e.message ?: "That didn't work." else "Can't reach Family Screen Warden. Call a grown-up instead."
        }
    }

    // ---------------------------------------------------------------- ring
    private var ringStop: Runnable? = null
    private var savedAlarm = -1

    /** Ring phone from the parent console (the id changes with every ring): loud for 30 seconds, even on mute. */
    fun ringIfAsked(id: String?) {
        if (id == null || id == lastRing) return
        lastRing = id
        ctx.getSharedPreferences("where", Context.MODE_PRIVATE).edit().putString("ring", id).apply()
        main.post { ring() }
    }

    private fun ring() {
        val am = ctx.getSystemService(AudioManager::class.java)
        if (savedAlarm < 0) savedAlarm = am.getStreamVolume(AudioManager.STREAM_ALARM)
        runCatching { am.setStreamVolume(AudioManager.STREAM_ALARM, am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0) }
        Sound.familyRing(false)
        val r = RingtoneManager.getRingtone(ctx, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM) ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE))
        runCatching {
            r.audioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
            if (Build.VERSION.SDK_INT >= 28) r.isLooping = true
            r.play()
        }
        val stop = Intent(ctx, LauncherActivity::class.java).putExtra("stopRing", true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        val n = NotificationCompat.Builder(ctx, "kids").setSmallIcon(R.drawable.ic_notify).setContentTitle("Your grown-ups are looking for your phone")
            .setContentText("Tap to stop the ringing.").setPriority(NotificationCompat.PRIORITY_HIGH).setAutoCancel(true)
            .setContentIntent(PendingIntent.getActivity(ctx, 77, stop, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)).build()
        runCatching { ctx.getSystemService(NotificationManager::class.java).notify(77, n) }
        ringing = r
        ringStop?.let { main.removeCallbacks(it) }
        ringStop = Runnable { stopRing() }.also { main.postDelayed(it, 30_000) }
    }

    private var ringing: android.media.Ringtone? = null
    fun stopRing() {
        main.post {
            runCatching { ringing?.stop() }
            ringing = null
            ringStop?.let { main.removeCallbacks(it) }
            if (savedAlarm >= 0) runCatching { ctx.getSystemService(AudioManager::class.java).setStreamVolume(AudioManager.STREAM_ALARM, savedAlarm, 0) }
            savedAlarm = -1
            runCatching { ctx.getSystemService(NotificationManager::class.java).cancel(77) }
        }
    }

}
