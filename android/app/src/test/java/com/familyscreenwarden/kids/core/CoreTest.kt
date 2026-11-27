package com.familyscreenwarden.kids.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EngineTest {
    private val t0 = 1_800_000_000_000L
    private fun snap(minutes: Int = 60, used: Int = 0, apps: List<AppRule> = emptyList(), appMinutes: Map<String, Int> = emptyMap(), locked: Boolean = false, bedtime: BedtimeInfo? = null) = Snapshot(
        serverTime = msIso(t0), day = "2027-01-15", dayEndsAt = msIso(t0 + 10 * 3600_000L),
        allowance = AllowanceInfo(generalMinutes = minutes, baseMinutes = minutes, appMinutes = appMinutes),
        used = UsedInfo(generalSeconds = used), apps = apps, locked = locked, bedtime = bedtime,
    )

    @Test fun countsOnlyWhileAnAppIsInFront() {
        val e = Engine()
        e.applySnapshot(snap(), t0)
        e.tick(t0, 60.0, interactive = true, foreground = null, foregroundFree = false, budgeted = false)
        assertEquals(3600, e.generalLeft())
        e.tick(t0, 60.0, interactive = true, foreground = "minecraft", foregroundFree = false, budgeted = false)
        assertEquals(3540, e.generalLeft())
        e.tick(t0, 60.0, interactive = false, foreground = "minecraft", foregroundFree = false, budgeted = false)
        assertEquals(3540, e.generalLeft())
    }

    @Test fun othersDevicesCountToo() {
        val e = Engine()
        e.applySnapshot(snap(minutes = 30, used = 1700), t0)
        assertEquals(100, e.generalLeft())
        e.tick(t0, 100.0, true, "x", false, false)
        assertEquals("locked", e.status(t0).state)
        assertEquals("time", e.status(t0).lockReason)
    }

    @Test fun freeAppsDontUseTheDay() {
        val e = Engine()
        val r = AppRule(key = "khan", name = "Khan", allowed = true, free = true)
        e.applySnapshot(snap(apps = listOf(r)), t0)
        e.tick(t0, 600.0, true, "khan", true, false)
        assertEquals(3600, e.generalLeft())
    }

    @Test fun dailyLimitBlocksTheApp() {
        val e = Engine()
        val r = AppRule(key = "roblox", name = "Roblox", allowed = true, limitMinutes = 10)
        e.applySnapshot(snap(apps = listOf(r)), t0)
        e.tick(t0, 600.0, true, "roblox", false, false)
        val s = e.status(t0)
        assertEquals("ok", s.state)
        assertTrue("roblox" in s.blockedAppKeys)
        assertTrue(e.notices().any { it.text.contains("Roblox") })
    }

    @Test fun parentLockAndPass() {
        val e = Engine()
        e.applySnapshot(snap(locked = true), t0)
        assertEquals("parent", e.status(t0).lockReason)
        e.applyUnlock(1, t0)
        assertEquals("pass", e.status(t0).state)
        assertEquals("parent", e.status(t0 + 61 * 60_000L).lockReason)
    }

    @Test fun bedtimeAndSkip() {
        val e = Engine()
        e.applySnapshot(snap(bedtime = BedtimeInfo(msIso(t0 - 60_000), msIso(t0 + 3600_000))), t0)
        assertEquals("bedtime", e.status(t0).lockReason)
        e.skipBedtime(t0, 30)
        assertEquals("ok", e.status(t0).state)
        assertEquals("bedtime", e.status(t0 + 31 * 60_000L).lockReason)
    }

    @Test fun phonesClockDoesNotMatter() {
        val e = Engine()
        // The phone thinks it's an hour earlier; the server's clock wins.
        e.applySnapshot(snap(bedtime = BedtimeInfo(msIso(t0 - 60_000), msIso(t0 + 3600_000))), t0 - 3600_000)
        assertEquals("bedtime", e.status(t0 - 3600_000).lockReason)
    }

    @Test fun newDayOffline() {
        val e = Engine()
        e.applySnapshot(snap(minutes = 60, used = 3600), t0)
        assertEquals("locked", e.status(t0).state)
        e.tick(t0 + 11 * 3600_000L, 1.0, false, null, false, false)
        assertEquals("2027-01-16", e.state.day)
        assertEquals("ok", e.status(t0 + 11 * 3600_000L).state)
    }

    @Test fun reportingIsNotCountedTwice() {
        val e = Engine()
        e.applySnapshot(snap(), t0)
        e.tick(t0, 120.0, true, "a", false, false)
        val (day, g, apps) = e.usageToReport()
        e.markReported(day, g, apps)
        // The server now says 120 s were used (ours): still 120 s used, not 240.
        e.applySnapshot(snap(used = 120), t0)
        assertEquals(3480, e.generalLeft())
    }
}

class UnlockCodesTest {
    // The same secret and counter as the server's unlock code for them: 64113070.
    private val secret = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="
    @Test fun matchesTheServer() = assertEquals("64113070", UnlockCodes.compute(secret, 3))
    @Test fun findsTheCounter() = assertEquals(3L, UnlockCodes.tryMatch(secret, "6411 3070", 2))
    @Test fun usedOnce() = assertNull(UnlockCodes.tryMatch(secret, "64113070", 3))
    @Test fun voided() = assertNull(UnlockCodes.tryMatch(secret, "64113070", 0, voided = setOf(3L)))
}

class AppMatchTest {
    private val rules = listOf(
        AppRule(key = "minecraft", name = "Minecraft", exes = listOf("com.mojang.minecraftpe"), allowed = true),
        AppRule(key = "toca-boca-world", name = "Toca boca world", allowed = true),
    )
    @Test fun byPackage() = assertEquals("minecraft", AppMatch.ruleFor(InstalledApp("com.mojang.minecraftpe", "Minecraft PE"), rules)?.key)
    @Test fun byName() = assertEquals("toca-boca-world", AppMatch.ruleFor(InstalledApp("com.tocaboca.tocalifeworld", "Toca Boca World"), rules)?.key)
    @Test fun none() = assertNull(AppMatch.ruleFor(InstalledApp("com.roblox.client", "Roblox"), rules))
    @Test fun keyLikeTheServer() = assertEquals("bloons-td-6", AppMatch.key("Bloons TD 6"))
}

class SafeSearchTest {
    private val on = SafeSearchInfo(search = true, youTube = true)
    @Test fun google() { assertEquals(SafeSearch.GOOGLE_SAFE, SafeSearch.cname("www.google.co.uk", on)); assertEquals(SafeSearch.GOOGLE_SAFE, SafeSearch.cname("google.com", on)) }
    @Test fun notMail() = assertNull(SafeSearch.cname("mail.google.com", on))
    @Test fun youtube() = assertEquals(SafeSearch.YOUTUBE_RESTRICT, SafeSearch.cname("m.youtube.com", on))
    @Test fun off() = assertNull(SafeSearch.cname("www.google.com", SafeSearchInfo(false, false)))
    @Test fun doh() { assertTrue(SafeSearch.isEncryptedDns("dns.google")); assertFalse(SafeSearch.isEncryptedDns("google.com")) }
}

class DnsTest {
    /** A real-looking question: id 0x1234, www.google.com, A. */
    private fun question(name: String, type: Int = 1): ByteArray {
        val o = java.io.ByteArrayOutputStream()
        o.write(byteArrayOf(0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0))
        for (l in name.split('.')) { o.write(l.length); o.write(l.toByteArray()) }
        o.write(0); o.write(0); o.write(type); o.write(0); o.write(1)
        return o.toByteArray()
    }

    @Test fun parse() {
        val q = Dns.parseQuery(question("www.google.com"))
        assertNotNull(q)
        assertEquals("www.google.com", q!!.name)
        assertEquals(0x1234, q.id)
        assertEquals(1, q.type)
    }

    @Test fun nxdomain() {
        val raw = question("dns.google")
        val r = Dns.nxdomain(raw, Dns.parseQuery(raw)!!)
        assertEquals(0x83, r[3].toInt() and 0xff)
        assertEquals(0x12, r[0].toInt())
    }

    @Test fun cnameAnswer() {
        val raw = question("www.google.com")
        val q = Dns.parseQuery(raw)!!
        val renamed = Dns.rename(raw, q, SafeSearch.GOOGLE_SAFE)
        assertEquals("forcesafesearch.google.com", Dns.parseQuery(renamed)!!.name)
        // Upstream answer: the renamed question + one A record (216.239.38.120) pointing back at the question name.
        val up = java.io.ByteArrayOutputStream()
        up.write(renamed.copyOfRange(0, 2)); up.write(byteArrayOf(0x81.toByte(), 0x80.toByte(), 0, 1, 0, 1, 0, 0, 0, 0))
        up.write(renamed, 12, renamed.size - 12)
        up.write(byteArrayOf(0xc0.toByte(), 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 216.toByte(), 239.toByte(), 38, 120))
        val ans = Dns.cnameAnswer(raw, q, SafeSearch.GOOGLE_SAFE, up.toByteArray())
        // id kept, 2 answers (CNAME + A), question is the kid's original name.
        assertEquals(0x12, ans[0].toInt())
        assertEquals(2, ans[7].toInt())
        assertEquals("www.google.com", Dns.readName(ans, 12)!!.first)
        // The A record's name was written out in full (not a pointer into the upstream message).
        val text = String(ans, Charsets.ISO_8859_1)
        assertTrue(text.contains("forcesafesearch"))
        assertTrue(ans.takeLast(4).map { it.toInt() and 0xff } == listOf(216, 239, 38, 120))
    }

    @Test fun udpRoundTrip() {
        val payload = question("example.com")
        val p = Dns.buildUdp(byteArrayOf(10, 0, 0, 2), byteArrayOf(10, 0, 0, 1), 5555, 53, payload)
        val u = Dns.parseUdp(p, p.size)!!
        assertEquals(5555, u.srcPort); assertEquals(53, u.dstPort)
        assertTrue(u.payload.contentEquals(payload))
        // A valid IPv4 header sums to zero.
        assertEquals(0, Dns.checksum(p, 0, 20, 0))
    }
}
