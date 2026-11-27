package com.familyscreenwarden.kids

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

class WardenApiException(message: String, val status: Int?, val reached: Boolean) : Exception(message)

/**
 * ALL of the app's traffic with the Family Screen Warden server goes through this one class: the JSON calls
 * (/api/warden/... and /api/android/...) and the file downloads (pushed APKs and this
 * app's own updates). Nothing else in the app opens a connection to the server, so another backend can be added
 * later by swapping or extending this class; callers only use [post] and [download].
 * /api/warden/... is shared with the Windows app; /api/android/... is only for phones.
 */
class WardenApi(serverUrl: String, private val token: String? = null) {
    val base = serverUrl.trimEnd('/')

    suspend fun post(path: String, body: JsonElement): String = withContext(Dispatchers.IO) {
        val c = open("$base/api/$path")
        try {
            c.requestMethod = "POST"
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(body.toString().toByteArray()) }
            read(c)
        } catch (e: IOException) {
            throw WardenApiException("Can't reach Family Screen Warden.", null, false)
        } finally {
            c.disconnect()
        }
    }

    private fun open(url: String): HttpURLConnection {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 15_000
        c.readTimeout = 25_000
        c.setRequestProperty("Accept", "application/json")
        if (!token.isNullOrEmpty()) c.setRequestProperty("Authorization", "Bearer $token")
        return c
    }

    private fun read(c: HttpURLConnection): String {
        val code = c.responseCode
        val text = (if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
        if (code !in 200..299) {
            val msg = runCatching { Json.parseToJsonElement(text).jsonObject["error"]?.jsonPrimitive?.content }.getOrNull() ?: "Family Screen Warden said no ($code)."
            throw WardenApiException(msg, code, true)
        }
        return text
    }

    /** Downloads a file (a path on the server or a full address) and checks its SHA-256. */
    suspend fun download(url: String, dest: File, sha256: String?) = withContext(Dispatchers.IO) {
        val full = if (url.startsWith("http")) url else base + "/" + url.trimStart('/')
        val c = open(full)
        c.readTimeout = 120_000
        try {
            if (c.responseCode !in 200..299) throw WardenApiException("Download failed (${c.responseCode}).", c.responseCode, true)
            val md = MessageDigest.getInstance("SHA-256")
            val tmp = File(dest.path + ".part")
            c.inputStream.use { inp -> tmp.outputStream().use { out ->
                val buf = ByteArray(64 * 1024)
                while (true) { val n = inp.read(buf); if (n < 0) break; md.update(buf, 0, n); out.write(buf, 0, n) }
            } }
            val got = md.digest().joinToString("") { "%02x".format(it) }
            if (!sha256.isNullOrBlank() && !got.equals(sha256, true)) { tmp.delete(); throw WardenApiException("The download didn't check out.", null, true) }
            tmp.renameTo(dest)
        } catch (e: IOException) {
            throw WardenApiException("Can't reach Family Screen Warden.", null, false)
        } finally {
            c.disconnect()
        }
    }
}
