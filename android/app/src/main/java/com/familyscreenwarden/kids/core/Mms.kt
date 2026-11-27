package com.familyscreenwarden.kids.core

import java.io.ByteArrayOutputStream

/**
 * Picture and group texts (MMS): the binary messages carriers pass around (OMA MMS 1.2 encapsulation over WSP).
 * Android sends and downloads them for the phone's texting app, but the app reads and writes the bytes itself.
 *
 *  - [sendReq]: a text, photos and the people it goes to (a group text is one message to several people).
 *  - [parse]: a "you have a picture text" notice (m-notification-ind) or the downloaded text (m-retrieve-conf).
 *  - [notifyResp]: "got it", sent back after a download.
 */
object Mms {
    const val SEND_REQ = 0x80
    const val NOTIFICATION_IND = 0x82
    const val NOTIFYRESP_IND = 0x83
    const val RETRIEVE_CONF = 0x84

    private const val H_CC = 0x02
    private const val H_CONTENT_LOCATION = 0x03
    private const val H_CONTENT_TYPE = 0x04
    private const val H_DATE = 0x05
    private const val H_DELIVERY_REPORT = 0x06
    private const val H_FROM = 0x09
    private const val H_MESSAGE_CLASS = 0x0A
    private const val H_MESSAGE_TYPE = 0x0C
    private const val H_VERSION = 0x0D
    private const val H_MESSAGE_SIZE = 0x0E
    private const val H_READ_REPORT = 0x10
    private const val H_STATUS = 0x15
    private const val H_SUBJECT = 0x16
    private const val H_TO = 0x17
    private const val H_TRANSACTION_ID = 0x18

    class Part(val type: String, val data: ByteArray, val name: String = "", val charset: Int = 106) {
        val text: String? get() = if (type.startsWith("text/") && type != "text/x-vcard") decode(data, charset) else null
    }

    class Message(
        val type: Int,
        val transactionId: String = "",
        val from: String = "",
        val to: List<String> = emptyList(),
        val cc: List<String> = emptyList(),
        val subject: String = "",
        val dateSec: Long = 0,
        val contentLocation: String = "",
        val size: Long = 0,
        val parts: List<Part> = emptyList(),
    ) {
        val text: String get() = parts.mapNotNull { if (it.type == "application/smil") null else it.text }.joinToString("\n").trim()
        val media: List<Part> get() = parts.filter { it.type.startsWith("image/") || it.type.startsWith("video/") || it.type.startsWith("audio/") }
    }

    /** A number as carriers want it: digits and a leading + ("(555) 010-2231" → "5550102231"). */
    fun dialable(n: String) = address(n).let { a -> (if (a.trim().startsWith("+")) "+" else "") + a.filter { it.isDigit() } }

    /** Strips "/TYPE=PLMN" and the like from an MMS address. */
    fun address(a: String) = a.substringBefore('/').trim()

    // ------------------------------------------------------------------------------------------------ writing
    fun sendReq(transactionId: String, to: List<String>, text: String, media: List<Part>, nowSec: Long): ByteArray {
        val o = ByteArrayOutputStream()
        header(o, H_MESSAGE_TYPE); o.write(SEND_REQ)
        header(o, H_TRANSACTION_ID); textString(o, transactionId)
        header(o, H_VERSION); o.write(0x92) // 1.2
        header(o, H_DATE); longInt(o, nowSec)
        header(o, H_FROM); o.write(1); o.write(0x81) // insert-address-token: the network fills in the phone's number
        for (t in to) { header(o, H_TO); textString(o, "${dialable(t)}/TYPE=PLMN") }
        header(o, H_MESSAGE_CLASS); o.write(0x80) // personal
        header(o, H_DELIVERY_REPORT); o.write(0x81) // no
        header(o, H_READ_REPORT); o.write(0x81) // no
        // The parts: a small SMIL layout, the text, the photos (multipart/related, start = the SMIL).
        val parts = ArrayList<Part>()
        val items = StringBuilder()
        media.forEachIndexed { i, p ->
            val tag = when { p.type.startsWith("video/") -> "video"; p.type.startsWith("audio/") -> "audio"; else -> "img" }
            items.append("<par dur=\"5000ms\"><$tag src=\"${nameOf(p, i)}\" region=\"Image\"/></par>")
        }
        if (text.isNotEmpty()) items.append("<par dur=\"5000ms\"><text src=\"text.txt\" region=\"Text\"/></par>")
        val smil = "<smil><head><layout><root-layout/><region id=\"Image\" fit=\"meet\" top=\"0\" left=\"0\" height=\"80%\" width=\"100%\"/>" +
            "<region id=\"Text\" top=\"80%\" left=\"0\" height=\"20%\" width=\"100%\"/></layout></head><body>$items</body></smil>"
        parts += Part("application/smil", smil.toByteArray(), "smil.xml")
        media.forEachIndexed { i, p -> parts += Part(p.type, p.data, nameOf(p, i)) }
        if (text.isNotEmpty()) parts += Part("text/plain", text.toByteArray(Charsets.UTF_8), "text.txt")

        header(o, H_CONTENT_TYPE)
        val ct = ByteArrayOutputStream()
        ct.write(0xB3) // application/vnd.wap.multipart.related
        ct.write(0x89); textString(ct, "application/smil") // type
        ct.write(0x8A); textString(ct, "<smil>") // start
        valueLength(o, ct.size()); o.write(ct.toByteArray())

        uintvar(o, parts.size.toLong())
        for (p in parts) {
            val h = ByteArrayOutputStream()
            partType(h, p)
            val cid = if (p.type == "application/smil") "smil" else p.name.substringBeforeLast('.')
            h.write(0xC0); h.write(0x22); textString(h, "<$cid>") // Content-ID
            h.write(0x8E); textString(h, p.name) // Content-Location
            uintvar(o, h.size().toLong()); uintvar(o, p.data.size.toLong())
            o.write(h.toByteArray()); o.write(p.data)
        }
        return o.toByteArray()
    }

    fun notifyResp(transactionId: String): ByteArray {
        val o = ByteArrayOutputStream()
        header(o, H_MESSAGE_TYPE); o.write(NOTIFYRESP_IND)
        header(o, H_TRANSACTION_ID); textString(o, transactionId)
        header(o, H_VERSION); o.write(0x92)
        header(o, H_STATUS); o.write(0x81) // retrieved
        return o.toByteArray()
    }

    private fun nameOf(p: Part, i: Int): String {
        if (p.name.isNotEmpty()) return p.name
        val ext = when (p.type) { "image/png" -> "png"; "image/gif" -> "gif"; "video/mp4" -> "mp4"; "video/3gpp" -> "3gp"; "audio/amr" -> "amr"; else -> "jpg" }
        return "part$i.$ext"
    }

    private fun partType(o: ByteArrayOutputStream, p: Part) {
        val known = WELL_KNOWN.entries.firstOrNull { it.value == p.type }?.key
        if (p.type == "text/plain") { o.write(3); o.write(0x83); o.write(0x81); o.write(0x80 or 106) } // text/plain; charset=utf-8
        else if (known != null) o.write(0x80 or known)
        else textString(o, p.type)
    }

    private fun header(o: ByteArrayOutputStream, h: Int) = o.write(0x80 or h)
    private fun textString(o: ByteArrayOutputStream, s: String) {
        val b = s.toByteArray(Charsets.UTF_8)
        if (b.isNotEmpty() && (b[0].toInt() and 0xFF) >= 0x80) o.write(0x7F)
        o.write(b); o.write(0)
    }
    private fun longInt(o: ByteArrayOutputStream, v: Long) {
        var n = v
        val bytes = ArrayList<Int>()
        do { bytes.add(0, (n and 0xFF).toInt()); n = n ushr 8 } while (n > 0)
        o.write(bytes.size); bytes.forEach { o.write(it) }
    }
    private fun valueLength(o: ByteArrayOutputStream, n: Int) { if (n < 31) o.write(n) else { o.write(31); uintvar(o, n.toLong()) } }
    fun uintvar(o: ByteArrayOutputStream, v: Long) {
        val bytes = ArrayList<Int>()
        var n = v
        bytes.add((n and 0x7F).toInt()); n = n ushr 7
        while (n > 0) { bytes.add(0, ((n and 0x7F) or 0x80).toInt()); n = n ushr 7 }
        bytes.forEach { o.write(it) }
    }

    // ------------------------------------------------------------------------------------------------ reading
    private class Reader(val b: ByteArray, var i: Int = 0, val end: Int = b.size, val sized: Boolean = false) {
        fun more() = i < end
        fun u8(): Int = b[i++].toInt() and 0xFF
        fun peek(): Int = b[i].toInt() and 0xFF
        fun uintvar(): Long { var v = 0L; while (true) { val x = u8(); v = (v shl 7) or (x and 0x7F).toLong(); if (x and 0x80 == 0) return v } }
        fun text(): String {
            if (peek() == 0x7F || peek() == 0x22) i++
            val s = i
            while (i < end && b[i].toInt() != 0) i++
            val r = String(b, s, i - s, Charsets.UTF_8)
            if (i < end) i++
            return r
        }
        /** Any WSP value: its bytes (for a length-prefixed one, after the length). */
        fun value(): Reader {
            val f = peek()
            return when {
                f <= 30 -> { i++; Reader(b, i, i + f, true).also { i += f } }
                f == 31 -> { i++; val n = uintvar().toInt(); Reader(b, i, i + n, true).also { i += n } }
                f < 128 -> { val s = i; text(); Reader(b, s, i) }
                else -> { i++; Reader(b, i - 1, i) }
            }
        }
        fun longInt(): Long { val n = u8(); var v = 0L; repeat(n) { v = (v shl 8) or u8().toLong() }; return v }
        fun rest() = b.copyOfRange(i, end)
    }

    /** An encoded-string-value (an optional charset, then text). */
    private fun encodedString(r: Reader): String {
        if (!r.more()) return ""
        val f = r.peek()
        if (f < 32) {
            val v = r.value()
            val cs = if (v.peek() >= 0x80) v.u8() and 0x7F else v.longInt().toInt()
            val s = v.i
            var e = v.end
            if (e > s && v.b[e - 1].toInt() == 0) e--
            return decode(v.b.copyOfRange(s, e), cs)
        }
        return r.text()
    }

    fun parse(pdu: ByteArray): Message? = runCatching { parseOrThrow(pdu) }.getOrNull()

    private fun parseOrThrow(pdu: ByteArray): Message {
        val r = Reader(pdu)
        var type = 0; var tid = ""; var from = ""; var subject = ""; var date = 0L; var loc = ""; var size = 0L
        val to = ArrayList<String>(); val cc = ArrayList<String>()
        var parts: List<Part> = emptyList()
        while (r.more()) {
            val h = r.peek()
            if (h < 0x80) { r.text(); r.value(); continue } // an application header: name, value
            r.i++
            when (h and 0x7F) {
                H_MESSAGE_TYPE -> type = r.u8()
                H_TRANSACTION_ID -> tid = r.text()
                H_FROM -> { val v = r.value(); if (v.more() && v.u8() == 0x80) from = encodedString(v) }
                H_TO -> to += encodedString(r)
                H_CC -> cc += encodedString(r)
                H_SUBJECT -> subject = encodedString(r)
                H_DATE -> date = r.longInt()
                H_CONTENT_LOCATION -> loc = r.text()
                H_MESSAGE_SIZE -> size = r.longInt()
                H_CONTENT_TYPE -> { r.value(); parts = parseBody(r); break }
                else -> r.value()
            }
        }
        return Message(type, tid, address(from), to.map(::address), cc.map(::address), subject, date, loc, size, parts)
    }

    private fun parseBody(r: Reader): List<Part> {
        val n = r.uintvar().toInt()
        val out = ArrayList<Part>()
        repeat(n.coerceAtMost(50)) {
            val hl = r.uintvar().toInt()
            val dl = r.uintvar().toInt()
            val h = Reader(r.b, r.i, r.i + hl)
            r.i += hl
            val data = r.b.copyOfRange(r.i, r.i + dl)
            r.i += dl
            var type = "application/octet-stream"
            var charset = 106
            val ctv = h.value()
            if (ctv.more()) {
                if (!ctv.sized) type = if (ctv.peek() >= 0x80) WELL_KNOWN[ctv.u8() and 0x7F] ?: type else ctv.text()
                else {
                    type = if (ctv.peek() >= 0x80) WELL_KNOWN[ctv.u8() and 0x7F] ?: type else ctv.text()
                    while (ctv.more()) {
                        val p = ctv.peek()
                        if (p == 0x81) { ctv.u8(); charset = if (ctv.peek() >= 0x80) ctv.u8() and 0x7F else ctv.longInt().toInt() }
                        else if (p >= 0x80) { ctv.u8(); ctv.value() } else { ctv.text(); if (ctv.more()) ctv.value() }
                    }
                }
            }
            var name = ""
            while (h.more()) {
                val x = h.peek()
                if (x == 0x8E) { h.u8(); name = h.text() }
                else if (x >= 0x80) { h.u8(); h.value() }
                else { h.text(); if (h.more()) h.value() }
            }
            out += Part(type.lowercase(), data, name, charset)
        }
        return out
    }

    private fun decode(b: ByteArray, charset: Int): String = when (charset) {
        3 -> String(b, Charsets.US_ASCII)
        4 -> String(b, Charsets.ISO_8859_1)
        1000 -> String(b, Charsets.UTF_16BE)
        1015 -> String(b, Charsets.UTF_16)
        else -> String(b, Charsets.UTF_8)
    }

    private val WELL_KNOWN = mapOf(
        0x03 to "text/plain", 0x06 to "text/x-vcard", 0x1D to "image/gif", 0x1E to "image/jpeg", 0x1F to "image/tiff",
        0x20 to "image/png", 0x21 to "image/vnd.wap.wbmp", 0x23 to "application/vnd.wap.multipart.mixed", 0x33 to "application/vnd.wap.multipart.related",
    )
}
