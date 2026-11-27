package com.familyscreenwarden.kids

import android.app.Activity
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.IBinder
import android.provider.Telephony
import java.io.File

/** What makes Family Screen Warden the phone's texting app (Android asks a default SMS app for all of these). */
private fun ready(c: Context) { Kids.init(c); Texts.init(c) }

private fun isDefaultSms(c: Context) = Telephony.Sms.getDefaultSmsPackage(c) == c.packageName

/** A text arrived (only the default texting app gets SMS_DELIVER). */
class SmsDeliverReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_DELIVER_ACTION) return
        ready(context)
        deliver(intent)
    }
}

internal fun deliver(intent: Intent) {
    val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
    val first = parts.firstOrNull() ?: return
    val from = first.originatingAddress ?: first.displayOriginatingAddress ?: return
    Texts.incomingSms(from, parts.joinToString("") { it.messageBody ?: "" }, first.timestampMillis.takeIf { it > 0 } ?: System.currentTimeMillis())
}

/** Texts every app may hear about (SMS_RECEIVED): used only while Family Screen Warden isn't the texting app yet. */
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        ready(context)
        if (!isDefaultSms(context)) deliver(intent)
    }
}

/** "You have a picture text" from the carrier. */
class WapPushReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.WAP_PUSH_DELIVER_ACTION) return
        ready(context)
        intent.getByteArrayExtra("data")?.let { Texts.mmsNotice(it) }
    }
}

/** A text (or picture text) went, or didn't. */
class TextSentReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        ready(context)
        val id = intent.getStringExtra("id") ?: return
        val ok = resultCode == Activity.RESULT_OK
        intent.getStringExtra("file")?.let { File(it).delete() }
        if (!ok || intent.getBooleanExtra("last", true)) Texts.setSent(id, ok)
    }
}

/** A picture text finished downloading. */
class MmsDownloadedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        ready(context)
        val tid = intent.getStringExtra("tid") ?: return
        val file = intent.getStringExtra("file")?.let { File(it) } ?: return
        Texts.downloaded(tid, file, resultCode == Activity.RESULT_OK)
    }
}

/** "Reply with a text" from a ringing call. Only to people the kid can text. */
class QuickReplyService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ready(this)
        val to = intent?.data?.schemeSpecificPart?.substringBefore('?')?.split(',', ';')?.map { it.trim() }?.filter { it.isNotEmpty() }.orEmpty()
        val text = intent?.getStringExtra(Intent.EXTRA_TEXT).orEmpty()
        if (to.isNotEmpty() && text.isNotBlank()) Texts.send(to, text, emptyList())
        stopSelf(startId)
        return START_NOT_STICKY
    }
}

/** "Text this number" from another app (sms: / smsto: links): opens the texts screen there, if the kid can text them. */
class ComposeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ready(this)
        val to = intent?.data?.schemeSpecificPart?.substringBefore('?')?.split(',', ';')?.map { it.trim() }?.filter { it.isNotEmpty() }.orEmpty()
        val body = intent?.getStringExtra("sms_body") ?: intent?.getStringExtra(Intent.EXTRA_TEXT)
        startActivity(Intent(this, TextsActivity::class.java).putExtra("to", to.toTypedArray()).putExtra("text", body).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        finish()
    }
}
