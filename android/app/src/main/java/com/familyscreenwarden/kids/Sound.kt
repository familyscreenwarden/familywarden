package com.familyscreenwarden.kids

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
import android.provider.CallLog
import android.provider.Settings
import android.util.Log
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * "Sound and screen" on the launcher (the Sound and screen button): the kid's own sound mode, volumes, brightness, how soon the
 * screen turns off, and text size in this app's screens.
 *
 *  - Sound on / Vibrate / Mute. Vibrate and Mute: family calls still ring (this app plays the ringtone itself, on the
 *    alarm sound, because Android's ringer is quiet then), and alarms always ring. Mute also silences videos and games
 *    and the texts app's alerts. (A fully silent ringer needs Do Not Disturb access, which an app can't give itself,
 *    so Mute uses vibrate for other callers.)
 *  - Brightness and "screen turns off after": the device owner sets them (DevicePolicyManager.setSystemSetting);
 *    a quick-install phone can only if a grown-up allowed "Modify system settings", else only this app's screens dim.
 */
object Sound {
    private lateinit var ctx: Context
    private val prefs by lazy { ctx.createDeviceProtectedStorageContext().getSharedPreferences("sound", Context.MODE_PRIVATE) }
    private val am by lazy { ctx.getSystemService(AudioManager::class.java) }
    private var ring: Ringtone? = null

    fun init(c: Context) { if (!::ctx.isInitialized) ctx = c.applicationContext }

    /** normal | vibrate | mute */
    val mode: String get() = prefs.getString("mode", null) ?: when (am.ringerMode) { AudioManager.RINGER_MODE_NORMAL -> "normal"; else -> "vibrate" }
    val quiet get() = mode != "normal"
    /** Text size in this app's screens (WebView textZoom): 100, 115 or 130. */
    val textZoom: Int get() = prefs.getInt("zoom", 100)
    /** The window brightness this app's own screens use when Android won't let the app set the phone's (0..1, -1 = phone's). */
    val windowBrightness: Float get() = prefs.getFloat("winBright", -1f)

    private fun level(stream: Int) = am.getStreamVolume(stream) * 100 / am.getStreamMaxVolume(stream).coerceAtLeast(1)
    private fun setLevel(stream: Int, pct: Int) = runCatching {
        am.setStreamVolume(stream, (pct.coerceIn(0, 100) * am.getStreamMaxVolume(stream) + 50) / 100, 0)
    }.onFailure { Log.w(Kids.TAG, "volume: ${it.message}") }

    fun setMode(m: String) {
        val mm = if (m in listOf("normal", "vibrate", "mute")) m else "normal"
        // Coming back from Mute: videos get their sound back.
        if (mode == "mute" && mm != "mute") prefs.getInt("mediaBefore", -1).takeIf { it >= 0 }?.let { setLevel(AudioManager.STREAM_MUSIC, it) }
        if (mm == "mute" && mode != "mute") { prefs.edit().putInt("mediaBefore", level(AudioManager.STREAM_MUSIC)).apply(); setLevel(AudioManager.STREAM_MUSIC, 0) }
        runCatching { am.ringerMode = if (mm == "normal") AudioManager.RINGER_MODE_NORMAL else AudioManager.RINGER_MODE_VIBRATE }
            .onFailure { Log.w(Kids.TAG, "ringer: ${it.message}") }
        prefs.edit().putString("mode", mm).apply()
    }

    /** media | ring | notif, 0..100. */
    fun setVolume(which: String, pct: Int) {
        when (which) {
            "media" -> setLevel(AudioManager.STREAM_MUSIC, pct)
            "ring" -> setLevel(AudioManager.STREAM_RING, pct)
            "notif" -> setLevel(AudioManager.STREAM_NOTIFICATION, pct)
        }
        if (which == "media" && pct > 0 && mode == "mute") prefs.edit().putString("mode", "vibrate").apply()
    }

    private fun canSet() = Kids.policy.isOwner || Settings.System.canWrite(ctx)

    /** 0..100. Returns a message for the kid when only this app's screens could change. */
    fun setBrightness(pct: Int): String? {
        val v = (pct.coerceIn(2, 100) * 255 / 100).toString()
        val ok = runCatching {
            if (Kids.policy.isOwner) {
                Kids.policy.systemSetting(Settings.System.SCREEN_BRIGHTNESS_MODE, Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL.toString())
                Kids.policy.systemSetting(Settings.System.SCREEN_BRIGHTNESS, v)
            } else if (Settings.System.canWrite(ctx)) {
                Settings.System.putInt(ctx.contentResolver, Settings.System.SCREEN_BRIGHTNESS_MODE, Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL)
                Settings.System.putInt(ctx.contentResolver, Settings.System.SCREEN_BRIGHTNESS, v.toInt())
            } else false
        }.getOrDefault(false)
        prefs.edit().putFloat("winBright", if (ok) -1f else pct.coerceIn(2, 100) / 100f).apply()
        return if (ok) null else "This phone only lets Screen Warden's screens get brighter or darker."
    }

    private fun brightness(): Int = runCatching { Settings.System.getInt(ctx.contentResolver, Settings.System.SCREEN_BRIGHTNESS) * 100 / 255 }.getOrDefault(60).coerceIn(0, 100)

    /** Seconds before the screen turns off. */
    fun setTimeout(sec: Int): String? {
        val ms = (sec.coerceIn(15, 600) * 1000).toString()
        val ok = runCatching {
            if (Kids.policy.isOwner) Kids.policy.systemSetting(Settings.System.SCREEN_OFF_TIMEOUT, ms)
            else if (Settings.System.canWrite(ctx)) Settings.System.putInt(ctx.contentResolver, Settings.System.SCREEN_OFF_TIMEOUT, ms.toInt())
            else false
        }.getOrDefault(false)
        return if (ok) null else "Ask a grown-up to change this in the phone's settings."
    }

    // ---- Auto-rotate (Android's "turn the screen with the phone"): on for every app by default.
    // Android only lets an app change it once a grown-up switched on "Modify system settings" for Family Screen Warden
    // (a device owner can't switch that on by itself), so the grown-up menu has "Let the screen turn".
    val canRotate get() = Settings.System.canWrite(ctx)
    private fun rotationOn() = runCatching { Settings.System.getInt(ctx.contentResolver, Settings.System.ACCELEROMETER_ROTATION) == 1 }.getOrDefault(false)
    private val wantRotate get() = prefs.getBoolean("rotate", true)

    /** Returns a message for the kid when a grown-up has to allow it first. */
    fun setRotation(on: Boolean): String? {
        prefs.edit().putBoolean("rotate", on).apply()
        if (!canRotate) return "A grown-up turns this on once: Grown-up › Let the screen turn with the phone."
        runCatching { Settings.System.putInt(ctx.contentResolver, Settings.System.ACCELEROMETER_ROTATION, if (on) 1 else 0) }
            .onFailure { Log.w(Kids.TAG, "rotation: ${it.message}") }
        return null
    }

    private var rotateCheckedAt = 0L
    /** Every few seconds: keep auto-rotate the way the kid set it (on by default) once Android allows it. */
    fun keepRotation() {
        if (!::ctx.isInitialized) return
        val t = System.currentTimeMillis()
        if (t - rotateCheckedAt < 10_000) return
        rotateCheckedAt = t
        if (canRotate && rotationOn() != wantRotate) setRotation(wantRotate)
    }

    fun setTextZoom(z: Int) { prefs.edit().putInt("zoom", if (z in listOf(100, 115, 130)) z else 100).apply() }

    fun dto(): JsonObject = buildJsonObject {
        put("mode", mode)
        put("media", level(AudioManager.STREAM_MUSIC))
        put("ring", level(AudioManager.STREAM_RING))
        put("notif", level(AudioManager.STREAM_NOTIFICATION))
        put("brightness", if (windowBrightness >= 0) (windowBrightness * 100).toInt() else brightness())
        put("timeout", runCatching { Settings.System.getInt(ctx.contentResolver, Settings.System.SCREEN_OFF_TIMEOUT) / 1000 }.getOrDefault(60))
        put("zoom", textZoom)
        put("canSet", canSet())
        put("rotate", if (canRotate) rotationOn() else wantRotate)
        put("canRotate", canRotate)
    }

    /** A family member is calling while the phone is on Vibrate or Mute: ring anyway (on the alarm sound). */
    fun familyRing(on: Boolean) {
        if (!on) { runCatching { ring?.stop() }; ring = null; return }
        if (ring?.isPlaying == true) return
        runCatching {
            val r = RingtoneManager.getRingtone(ctx, RingtoneManager.getActualDefaultRingtoneUri(ctx, RingtoneManager.TYPE_RINGTONE)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)) ?: return
            r.audioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
            if (Build.VERSION.SDK_INT >= 28) r.isLooping = true
            r.play()
            ring = r
        }.onFailure { Log.w(Kids.TAG, "family ring: ${it.message}") }
    }

    /** The last calls, for the Phone menu (needs the call-log permission the device owner grants). */
    fun recentCalls(name: (String) -> String?): JsonArray = buildJsonArray {
        runCatching {
            ctx.contentResolver.query(
                CallLog.Calls.CONTENT_URI, arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION), null, null, "${CallLog.Calls.DATE} desc",
            )?.use { c ->
                var n = 0
                while (c.moveToNext() && n < 8) {
                    val num = c.getString(0) ?: continue
                    add(buildJsonObject {
                        put("name", name(num) ?: num)
                        put("type", when (c.getInt(1)) { CallLog.Calls.OUTGOING_TYPE -> "out"; CallLog.Calls.MISSED_TYPE, CallLog.Calls.REJECTED_TYPE -> "missed"; else -> "in" })
                        put("at", c.getLong(2))
                        put("sec", c.getLong(3))
                    })
                    n++
                }
            }
        }
    }
}
