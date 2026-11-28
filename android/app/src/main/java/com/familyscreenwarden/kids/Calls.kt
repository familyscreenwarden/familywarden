package com.familyscreenwarden.kids

import android.annotation.SuppressLint
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.role.RoleManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.telecom.Call
import android.telecom.CallAudioState
import android.telecom.InCallService
import android.telecom.TelecomManager
import android.telephony.PhoneStateListener
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Phone calls on the kid's phone. Family Screen Warden is the phone's call app (Android's "default phone app", set by the
 * device owner on Android 14+, or allowed once at setup), so the phone's own call screen never shows: the launcher's
 * call bar does, with the caller's name from the family contacts in Family Screen Warden.
 *  - KidsInCallService hands every call to [add]; answer, hang up, mute and speaker work on the Call itself.
 *  - Ringing shows a call notification (Answer / Decline, full screen over the lock screen) that opens the launcher.
 *  - While time is up or at bedtime, calls from anyone who isn't an "always" family contact are turned away.
 *  - Without the phone-app role (an older phone where it wasn't allowed), the older way still works: the phone's
 *    state is watched and TelecomManager answers and hangs up.
 */
@SuppressLint("MissingPermission")
object Calls {
    enum class State { IDLE, RINGING, ACTIVE }

    @Volatile var state = State.IDLE; private set
    @Volatile var number: String? = null
    @Volatile private var since = 0L
    private var started = false
    private lateinit var ctx: Context
    private var call: Call? = null
    var service: InCallService? = null
    private var proximity: PowerManager.WakeLock? = null
    private const val NOTE = 77

    /** True when Family Screen Warden is the phone's call app (its own call screen). */
    fun isPhoneApp(c: Context): Boolean = runCatching {
        if (Build.VERSION.SDK_INT >= 29) c.getSystemService(RoleManager::class.java).isRoleHeld(RoleManager.ROLE_DIALER)
        else c.getSystemService(TelecomManager::class.java).defaultDialerPackage == c.packageName
    }.getOrDefault(false)

    fun start(context: Context) {
        if (started) return
        started = true
        ctx = context.applicationContext
        val tm = ctx.getSystemService(TelephonyManager::class.java) ?: return
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                tm.registerTelephonyCallback(ctx.mainExecutor, object : TelephonyCallback(), TelephonyCallback.CallStateListener {
                    override fun onCallStateChanged(s: Int) { if (call == null) legacy(s, null) }
                })
            } else {
                @Suppress("DEPRECATION")
                Handler(Looper.getMainLooper()).post {
                    tm.listen(object : PhoneStateListener() {
                        @Deprecated("old Android") override fun onCallStateChanged(s: Int, n: String?) { if (call == null) legacy(s, n) }
                    }, PhoneStateListener.LISTEN_CALL_STATE)
                }
            }
        } catch (e: Exception) { Log.w(Kids.TAG, "calls: ${e.message}") }
    }

    // ---------------------------------------------------------------- as the phone's call app (InCallService)
    private val callback = object : Call.Callback() {
        override fun onStateChanged(c: Call, s: Int) = fromCall(c)
        override fun onDetailsChanged(c: Call, d: Call.Details) = fromCall(c)
    }

    fun add(c: Call) {
        start(Kids.ctx)
        val n = c.details.handle?.schemeSpecificPart
        val incoming = stateOf(c) == Call.STATE_RINGING
        // Locked (time's up, bedtime, a grown-up): only "always" family contacts get through.
        if (incoming && Kids.paired && Kids.lockedNow && !Kids.isFamily(n)) {
            Log.i(Kids.TAG, "Turned away a call while the phone is locked")
            c.reject(false, null)
            return
        }
        // A second call while one is going: keep it simple for kids, turn it away.
        if (call != null && call !== c && incoming) { c.reject(false, null); return }
        call = c
        if (!n.isNullOrBlank()) number = n
        c.registerCallback(callback)
        fromCall(c)
    }

    fun remove(c: Call) {
        c.unregisterCallback(callback)
        if (call === c) { call = null; set(State.IDLE) }
    }

    @Suppress("DEPRECATION")
    private fun stateOf(c: Call) = if (Build.VERSION.SDK_INT >= 31) c.details.state else c.state

    private fun fromCall(c: Call) {
        if (c !== call) return
        c.details.handle?.schemeSpecificPart?.takeIf { it.isNotBlank() }?.let { number = it }
        set(when (stateOf(c)) {
            Call.STATE_RINGING -> State.RINGING
            Call.STATE_DISCONNECTED, Call.STATE_DISCONNECTING -> State.IDLE
            else -> State.ACTIVE
        })
    }

    // ---------------------------------------------------------------- the older way (not the phone's call app)
    private fun legacy(s: Int, n: String?) {
        if (!n.isNullOrBlank()) number = n
        set(when (s) {
            TelephonyManager.CALL_STATE_RINGING -> State.RINGING
            TelephonyManager.CALL_STATE_OFFHOOK -> State.ACTIVE
            else -> State.IDLE
        })
    }

    private fun set(s: State) {
        val before = state
        state = s
        if (s == before) { notifyCall(); return }
        since = System.currentTimeMillis()
        if (s == State.IDLE) {
            number = null
            runCatching { ctx.getSystemService(AudioManager::class.java).isMicrophoneMute = false }
        }
        screenNearEar(s == State.ACTIVE)
        // Vibrate or Mute: a family member's call still rings (Sound plays it on the alarm sound).
        if (s == State.RINGING && Sound.quiet && Kids.isFamily(number)) Sound.familyRing(true) else if (s != State.RINGING) Sound.familyRing(false)
        notifyCall()
        Kids.callChanged(s, before)
    }

    /** The kid tapped "Call" in the launcher. */
    fun dialing(n: String) { number = n }

    fun answer(): Boolean {
        call?.let { it.answer(0); return true }   // 0 = audio only
        return runCatching { @Suppress("DEPRECATION") ctx.getSystemService(TelecomManager::class.java).acceptRingingCall() }.isSuccess
    }

    fun hangUp(): Boolean {
        call?.let { if (stateOf(it) == Call.STATE_RINGING) it.reject(false, null) else it.disconnect(); return true }
        return runCatching { @Suppress("DEPRECATION") ctx.getSystemService(TelecomManager::class.java).endCall() }.getOrDefault(false)
    }

    fun mute(on: Boolean) {
        service?.let { it.setMuted(on); return }
        runCatching { ctx.getSystemService(AudioManager::class.java).isMicrophoneMute = on }
    }

    @Suppress("DEPRECATION")
    fun speaker(on: Boolean) {
        service?.let {
            it.setAudioRoute(if (on) CallAudioState.ROUTE_SPEAKER else CallAudioState.ROUTE_WIRED_OR_EARPIECE)
            screenNearEar(state == State.ACTIVE && !on)
            return
        }
        runCatching {
            val am = ctx.getSystemService(AudioManager::class.java)
            if (Build.VERSION.SDK_INT >= 31) {
                val dev = am.availableCommunicationDevices.firstOrNull { it.type == android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
                if (on && dev != null) am.setCommunicationDevice(dev) else am.clearCommunicationDevice()
            } else am.isSpeakerphoneOn = on
        }
    }

    @Suppress("DEPRECATION")
    private fun muted(): Boolean = service?.callAudioState?.isMuted ?: runCatching { ctx.getSystemService(AudioManager::class.java).isMicrophoneMute }.getOrDefault(false)

    @Suppress("DEPRECATION")
    private fun speakerOn(): Boolean = service?.callAudioState?.let { it.route == CallAudioState.ROUTE_SPEAKER } ?: runCatching {
        val am = ctx.getSystemService(AudioManager::class.java)
        if (Build.VERSION.SDK_INT >= 31) am.communicationDevice?.type == android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER else am.isSpeakerphoneOn
    }.getOrDefault(false)

    fun audioChanged() { Kids.page?.invoke(Kids.pageState()) }

    /** The screen goes dark when the phone is at the kid's ear (so a cheek doesn't tap Hang up). */
    private fun screenNearEar(on: Boolean) {
        runCatching {
            if (on && !speakerOn()) {
                if (proximity == null) proximity = ctx.getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "screenwarden:call")
                if (proximity?.isHeld == false) proximity?.acquire(4 * 3600_000L)
            } else if (proximity?.isHeld == true) proximity?.release()
        }
    }

    /** The call notification (Answer / Decline while ringing, Hang up during a call); full screen while ringing. */
    private fun notifyCall() {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        if (state == State.IDLE || call == null) { nm.cancel(NOTE); return }
        val name = Kids.contactName(number) ?: number ?: "Someone"
        val person = Person.Builder().setName(name).setImportant(true).build()
        val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        val open = PendingIntent.getActivity(ctx, 1, Intent(ctx, LauncherActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT), flags)
        fun act(a: String) = PendingIntent.getBroadcast(ctx, a.hashCode(), Intent(ctx, CallActionReceiver::class.java).setAction(a), flags)
        val style = if (state == State.RINGING) NotificationCompat.CallStyle.forIncomingCall(person, act("decline"), act("answer"))
                    else NotificationCompat.CallStyle.forOngoingCall(person, act("hangup"))
        val b = NotificationCompat.Builder(ctx, "calls").setSmallIcon(R.drawable.ic_notify).setStyle(style).setContentIntent(open)
            .setCategory(NotificationCompat.CATEGORY_CALL).setOngoing(true).setPriority(NotificationCompat.PRIORITY_MAX)
        if (state == State.RINGING) b.setFullScreenIntent(open, true)
        else b.setUsesChronometer(true).setWhen(since)
        runCatching { nm.notify(NOTE, b.build()) }
    }

    /** For the launcher page: null when there's no call. */
    fun dto(name: (String?) -> String?): JsonObject? {
        if (state == State.IDLE || !::ctx.isInitialized) return null
        return buildJsonObject {
            put("state", if (state == State.RINGING) "ringing" else "active")
            put("name", name(number) ?: number ?: "Someone")
            number?.let { put("number", it) }
            put("since", java.time.Instant.ofEpochMilli(since).toString())
            put("muted", muted())
            put("speaker", speakerOn())
        }
    }
}

/** Answer / Decline / Hang up from the call notification. */
class CallActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            "answer" -> { Calls.answer(); Kids.home() }
            "decline", "hangup" -> Calls.hangUp()
        }
    }
}

/**
 * Family Screen Warden as the phone's call app: Android hands it every call (incoming and outgoing), and the phone's own
 * call screen isn't shown. The launcher's call bar is the call screen; Android still plays the ringtone.
 */
class KidsInCallService : InCallService() {
    override fun onCreate() { super.onCreate(); Kids.init(this); Calls.service = this }
    override fun onDestroy() { if (Calls.service === this) Calls.service = null; super.onDestroy() }
    override fun onCallAdded(call: Call) { Calls.add(call) }
    override fun onCallRemoved(call: Call) { Calls.remove(call) }
    @Deprecated("Android's own name") override fun onCallAudioStateChanged(audioState: CallAudioState?) { Calls.audioChanged() }
}
