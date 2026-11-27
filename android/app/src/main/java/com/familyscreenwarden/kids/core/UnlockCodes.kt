package com.familyscreenwarden.kids.core

import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Emergency codes: HMAC-SHA256(secret, "unlock:" + n), first 4 bytes big-endian, mod 1e8. Checked offline (as on Windows). */
object UnlockCodes {
    fun compute(secretBase64: String, counter: Long): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(Base64.getDecoder().decode(secretBase64), "HmacSHA256"))
        val d = mac.doFinal("unlock:$counter".toByteArray(Charsets.UTF_8))
        val n = ((d[0].toLong() and 0xff) shl 24) or ((d[1].toLong() and 0xff) shl 16) or ((d[2].toLong() and 0xff) shl 8) or (d[3].toLong() and 0xff)
        return (n % 100_000_000L).toString().padStart(8, '0')
    }

    fun digits(input: String) = input.filter { it.isDigit() }

    /** The counter this code belongs to, trying the next few after the highest one used (voided ones skipped). */
    fun tryMatch(secretBase64: String, input: String, highestUsed: Long, window: Int = 10, voided: Set<Long> = emptySet()): Long? {
        val code = digits(input)
        if (code.length != 8 || secretBase64.isBlank()) return null
        var tried = 0
        var n = highestUsed + 1
        while (tried < window && n <= highestUsed + window + 200) {
            if (n !in voided) {
                tried++
                if (MessageDigest.isEqual(compute(secretBase64, n).toByteArray(), code.toByteArray())) return n
            }
            n++
        }
        return null
    }
}
