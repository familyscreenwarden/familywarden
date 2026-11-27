package com.familyscreenwarden.kids

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Telephony
import android.telecom.Call
import android.telecom.CallScreeningService
import android.telephony.SmsManager
import android.util.Log

/** Calls and texts with family (they always work, even when time is up). */
object Phone {
    /** Same number? Compares the last 9 digits ("(555) 010-2231" = "+1 555 010 2231"). */
    fun same(a: String, b: String): Boolean {
        val x = a.filter { it.isDigit() }.takeLast(9)
        val y = b.filter { it.isDigit() }.takeLast(9)
        return x.length >= 6 && x == y
    }

    /** Calls a number: straight through Android's telecom when Family Screen Warden is the phone app (its own call screen). */
    @android.annotation.SuppressLint("MissingPermission")
    fun call(ctx: Context, number: String) {
        val uri = Uri.fromParts("tel", number, null)
        runCatching {
            if (Calls.isPhoneApp(ctx)) ctx.getSystemService(android.telecom.TelecomManager::class.java).placeCall(uri, null)
            else ctx.startActivity(Intent(Intent.ACTION_CALL, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }.onFailure { Log.w(Kids.TAG, "call: ${it.message}") }
    }

    /** The emergency number: called right away when Family Screen Warden is the phone app, otherwise typed into the phone app. */
    @android.annotation.SuppressLint("MissingPermission")
    fun emergency(ctx: Context, number: String) {
        val n = number.filter { it.isDigit() }
        runCatching {
            if (Calls.isPhoneApp(ctx)) { Calls.dialing(n); ctx.getSystemService(android.telecom.TelecomManager::class.java).placeCall(Uri.fromParts("tel", n, null), null) }
            else ctx.startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:$n")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }.onFailure { Log.w(Kids.TAG, "emergency: ${it.message}") }
    }

    fun sms(ctx: Context, number: String, text: String): Boolean = try {
        val sm = if (Build.VERSION.SDK_INT >= 31) ctx.getSystemService(SmsManager::class.java) else @Suppress("DEPRECATION") SmsManager.getDefault()
        sm.sendMultipartTextMessage(number, null, sm.divideMessage(text), null, null)
        true
    } catch (e: Exception) { Log.w(Kids.TAG, "sms: ${e.message}"); false }
}

/** While the phone is locked (time's up, bedtime), only family can call in. Needs the call-screening role (setup asks). */
class FamilyCallScreening : CallScreeningService() {
    override fun onScreenCall(details: Call.Details) {
        Kids.init(this)
        val number = details.handle?.schemeSpecificPart
        if (!number.isNullOrBlank()) Calls.number = number
        val incoming = Build.VERSION.SDK_INT < 29 || details.callDirection == Call.Details.DIRECTION_INCOMING
        val block = incoming && Kids.paired && Kids.lockedNow && !Kids.isFamily(number)
        respondToCall(details, CallResponse.Builder().setDisallowCall(block).setRejectCall(block).setSkipNotification(false).setSkipCallLog(false).build())
    }
}
