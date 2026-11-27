package com.familyscreenwarden.kids

import android.content.Context
import android.provider.Settings
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import com.familyscreenwarden.kids.core.LocalState
import com.familyscreenwarden.kids.core.json
import java.io.File
import java.security.MessageDigest

/** The pairing (server, token, secret) and the time state, kept in the app's own storage (device-protected, so it works
 *  before the kid unlocks the phone after a restart). */
@Serializable data class Pairing(
    val server: String = "",
    val token: String = "",
    val secret: String = "",
    val computerId: String = "",
    val kidId: String = "",
    val kidName: String = "",
)

@Serializable data class FamilyMessage(val id: String, val contactId: String?, val name: String, val text: String, val at: String, val mine: Boolean = false)

class Store(context: Context) {
    private val ctx = context.applicationContext.createDeviceProtectedStorageContext()
    private val prefs = ctx.getSharedPreferences("kids", Context.MODE_PRIVATE)
    private val stateFile = File(ctx.filesDir, "state.json")
    private val launcherFile = File(ctx.filesDir, "launcher.json")
    private val messagesFile = File(ctx.filesDir, "messages.json")

    var pairing: Pairing?
        get() = prefs.getString("pairing", null)?.let { runCatching { json.decodeFromString<Pairing>(it) }.getOrNull() }?.takeIf { it.token.isNotEmpty() }
        set(v) { prefs.edit().putString("pairing", v?.let { json.encodeToString(it) }).apply() }

    /** From the QR code (Android's setup screen passes it to the app): the server's address and the setup code. */
    var setupServer: String?
        get() = prefs.getString("setupServer", null)
        set(v) { prefs.edit().putString("setupServer", v).apply() }
    var setupCode: String?
        get() = prefs.getString("setupCode", null)
        set(v) { prefs.edit().putString("setupCode", v).apply() }

    fun loadState(): LocalState = runCatching { json.decodeFromString<LocalState>(stateFile.readText()) }.getOrElse { LocalState() }
    fun saveState(s: LocalState) = atomic(stateFile, json.encodeToString(s))

    fun loadLauncher(): String? = runCatching { launcherFile.readText() }.getOrNull()
    fun saveLauncher(raw: String) = atomic(launcherFile, raw)

    fun loadMessages(): List<FamilyMessage> = runCatching { json.decodeFromString<List<FamilyMessage>>(messagesFile.readText()) }.getOrElse { emptyList() }
    fun saveMessages(m: List<FamilyMessage>) = atomic(messagesFile, json.encodeToString(m.takeLast(60)))

    /** This app on this phone (Android's id for it), hashed: the server pairs the same phone's row again. */
    fun deviceId(): String {
        val raw = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID) ?: "unknown"
        val d = MessageDigest.getInstance("SHA-256").digest("screenwarden-kids:$raw".toByteArray())
        return d.take(16).joinToString("") { "%02x".format(it) }
    }

    private fun atomic(f: File, text: String) {
        val tmp = File(f.path + ".tmp")
        tmp.writeText(text)
        tmp.renameTo(f)
    }
}
