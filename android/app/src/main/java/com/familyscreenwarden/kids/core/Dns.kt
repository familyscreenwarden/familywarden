package com.familyscreenwarden.kids.core

import java.io.ByteArrayOutputStream

/**
 * The little bit of DNS and IPv4/UDP the safe-browsing VPN needs (no Android calls, so it is tested on any machine).
 * The VPN only carries DNS: the phone asks its "DNS server" (an address inside the VPN), we read the name and either
 * pass the question on unchanged, answer "no such name", or point it at the SafeSearch address (a CNAME).
 */
object Dns {
    const val A = 1
    const val CNAME = 5
    const val AAAA = 28

    class Query(val id: Int, val name: String, val type: Int, val klass: Int, val questionEnd: Int)

    /** The first question of a DNS message, or null when it isn't one we understand. */
    fun parseQuery(msg: ByteArray): Query? {
        if (msg.size < 12) return null
        val flags = u16(msg, 2)
        if (flags and 0x8000 != 0) return null // an answer, not a question
        if (u16(msg, 4) < 1) return null
        val (name, end) = readName(msg, 12) ?: return null
        if (end + 4 > msg.size) return null
        return Query(u16(msg, 0), name, u16(msg, end), u16(msg, end + 2), end + 4)
    }

    /** Reads a (possibly compressed) name; returns it and where the name ends in the message. */
    fun readName(msg: ByteArray, start: Int): Pair<String, Int>? {
        val labels = mutableListOf<String>()
        var pos = start
        var end = -1
        var jumps = 0
        while (true) {
            if (pos >= msg.size) return null
            val len = msg[pos].toInt() and 0xff
            when {
                len == 0 -> { if (end < 0) end = pos + 1; break }
                len and 0xc0 == 0xc0 -> {
                    if (pos + 1 >= msg.size || ++jumps > 20) return null
                    if (end < 0) end = pos + 2
                    pos = ((len and 0x3f) shl 8) or (msg[pos + 1].toInt() and 0xff)
                }
                else -> {
                    if (pos + 1 + len > msg.size || len > 63) return null
                    labels += String(msg, pos + 1, len, Charsets.US_ASCII)
                    pos += 1 + len
                }
            }
        }
        return labels.joinToString(".").lowercase() to end
    }

    private fun writeName(out: ByteArrayOutputStream, name: String) {
        for (l in name.trimEnd('.').split('.')) {
            if (l.isEmpty()) continue
            val b = l.toByteArray(Charsets.US_ASCII)
            out.write(b.size); out.write(b)
        }
        out.write(0)
    }

    /** "No such name" for this question (encrypted-DNS services, so apps fall back to normal DNS through us). */
    fun nxdomain(q: ByteArray, query: Query): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(q, 0, 2) // id
        out.write(0x81); out.write(0x83) // answer, recursion desired + available, NXDOMAIN
        w16(out, 1); w16(out, 0); w16(out, 0); w16(out, 0)
        out.write(q, 12, query.questionEnd - 12)
        return out.toByteArray()
    }

    /** The same question for another name (the SafeSearch address), with the same id. */
    fun rename(q: ByteArray, query: Query, target: String): ByteArray {
        // Same id and flags, one question, no other records.
        val head = q.copyOfRange(0, 12)
        head[4] = 0; head[5] = 1
        for (i in 6..11) head[i] = 0
        val out = ByteArrayOutputStream()
        out.write(head)
        writeName(out, target)
        w16(out, query.type); w16(out, query.klass)
        return out.toByteArray()
    }

    /**
     * The answer to the kid's question about [query].name, built from the upstream answer about [target]:
     * "name is an alias of target" followed by target's addresses.
     */
    fun cnameAnswer(q: ByteArray, query: Query, target: String, upstream: ByteArray): ByteArray {
        val records = mutableListOf<ByteArray>()
        if (upstream.size >= 12) {
            val qd = u16(upstream, 4)
            val an = u16(upstream, 6)
            var pos = 12
            repeat(qd) {
                val (_, e) = readName(upstream, pos) ?: return@repeat
                pos = e + 4
            }
            repeat(an) {
                val r = readName(upstream, pos) ?: return@repeat
                val p = r.second
                if (p + 10 > upstream.size) return@repeat
                val type = u16(upstream, p)
                val rdlen = u16(upstream, p + 8)
                if (p + 10 + rdlen > upstream.size) return@repeat
                if (type == A || type == AAAA) {
                    val o = ByteArrayOutputStream()
                    writeName(o, r.first)
                    o.write(upstream, p, 10 + rdlen) // type, class, ttl, rdlength, rdata
                    records += o.toByteArray()
                }
                pos = p + 10 + rdlen
            }
        }
        val out = ByteArrayOutputStream()
        out.write(q, 0, 2)
        out.write(0x81); out.write(0x80) // answer, RD + RA, no error
        w16(out, 1); w16(out, 1 + records.size); w16(out, 0); w16(out, 0)
        out.write(q, 12, query.questionEnd - 12)
        // name CNAME target (ttl 300)
        out.write(0xc0); out.write(12)
        w16(out, CNAME); w16(out, 1); w32(out, 300)
        val t = ByteArrayOutputStream().also { writeName(it, target) }.toByteArray()
        w16(out, t.size); out.write(t)
        for (r in records) out.write(r)
        return out.toByteArray()
    }

    // ------------------------------------------------------------------ IPv4 + UDP (what the VPN reads and writes)
    class Udp(val src: ByteArray, val dst: ByteArray, val srcPort: Int, val dstPort: Int, val payload: ByteArray)

    fun parseUdp(pkt: ByteArray, len: Int): Udp? {
        if (len < 28 || (pkt[0].toInt() shr 4) != 4) return null
        val ihl = (pkt[0].toInt() and 0x0f) * 4
        if (pkt[9].toInt() != 17 || len < ihl + 8) return null
        val total = minOf(len, u16(pkt, 2))
        val udpLen = u16(pkt, ihl + 4)
        val payloadLen = minOf(udpLen - 8, total - ihl - 8)
        if (payloadLen < 0) return null
        return Udp(pkt.copyOfRange(12, 16), pkt.copyOfRange(16, 20), u16(pkt, ihl), u16(pkt, ihl + 2), pkt.copyOfRange(ihl + 8, ihl + 8 + payloadLen))
    }

    /** An IPv4/UDP packet from [src]:[srcPort] to [dst]:[dstPort]. */
    fun buildUdp(src: ByteArray, dst: ByteArray, srcPort: Int, dstPort: Int, payload: ByteArray): ByteArray {
        val total = 20 + 8 + payload.size
        val p = ByteArray(total)
        p[0] = 0x45; p[1] = 0
        p[2] = (total shr 8).toByte(); p[3] = total.toByte()
        p[4] = 0; p[5] = 0; p[6] = 0x40; p[7] = 0 // don't fragment
        p[8] = 64; p[9] = 17
        System.arraycopy(src, 0, p, 12, 4)
        System.arraycopy(dst, 0, p, 16, 4)
        val ipSum = checksum(p, 0, 20, 0)
        p[10] = (ipSum shr 8).toByte(); p[11] = ipSum.toByte()
        val u = 20
        p[u] = (srcPort shr 8).toByte(); p[u + 1] = srcPort.toByte()
        p[u + 2] = (dstPort shr 8).toByte(); p[u + 3] = dstPort.toByte()
        val ul = 8 + payload.size
        p[u + 4] = (ul shr 8).toByte(); p[u + 5] = ul.toByte()
        System.arraycopy(payload, 0, p, u + 8, payload.size)
        // UDP checksum over the pseudo header
        var pseudo = 0L
        for (i in 0 until 4 step 2) { pseudo += u16(src, i); pseudo += u16(dst, i) }
        pseudo += 17 + ul
        var sum = checksum(p, u, ul, pseudo)
        if (sum == 0) sum = 0xffff
        p[u + 6] = (sum shr 8).toByte(); p[u + 7] = sum.toByte()
        return p
    }

    fun checksum(b: ByteArray, off: Int, len: Int, initial: Long): Int {
        var s = initial
        var i = 0
        while (i + 1 < len) { s += u16(b, off + i); i += 2 }
        if (i < len) s += (b[off + i].toInt() and 0xff) shl 8
        while (s shr 16 != 0L) s = (s and 0xffff) + (s shr 16)
        return (s.inv() and 0xffff).toInt()
    }

    private fun u16(b: ByteArray, i: Int) = ((b[i].toInt() and 0xff) shl 8) or (b[i + 1].toInt() and 0xff)
    private fun w16(o: ByteArrayOutputStream, v: Int) { o.write((v shr 8) and 0xff); o.write(v and 0xff) }
    private fun w32(o: ByteArrayOutputStream, v: Int) { w16(o, v ushr 16); w16(o, v and 0xffff) }
}
