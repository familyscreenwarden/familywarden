package com.familyscreenwarden.kids.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalTime

class WebFilterTest {
    private val noon = LocalTime.NOON
    private val sites = listOf(SiteRule(host = "khanacademy.org"), SiteRule(host = "roblox.com", from = "16:00", to = "18:00"))

    @Test fun onlyTheKidsSites() {
        val w = WebInfo()
        assertFalse(WebFilter.blocked("www.khanacademy.org", w, sites, noon))
        assertTrue(WebFilter.blocked("wikipedia.org", w, sites, noon))
        assertTrue("outside its time", WebFilter.blocked("roblox.com", w, sites, noon))
        assertFalse("DNS lets apps work with the list mode", WebFilter.dnsBlocked("wikipedia.org", w, sites, noon))
    }

    @Test fun filteredWeb() {
        val w = WebInfo("filtered", listOf("tiktok.com", "roblox.com"), listOf("porn", "casino"))
        assertTrue(WebFilter.dnsBlocked("m.tiktok.com", w, sites, noon))
        assertFalse(WebFilter.dnsBlocked("wikipedia.org", w, sites, noon))
        assertTrue(WebFilter.dnsBlocked("free-porn.net", w, sites, noon))
        assertFalse(WebFilter.dnsBlocked("essex.ac.uk", w, sites, noon))
        assertFalse("on the kid's list at its time", WebFilter.dnsBlocked("roblox.com", w, sites, LocalTime.of(17, 0)))
        assertTrue(WebFilter.dnsBlocked("roblox.com", w, sites, noon))
    }

    @Test fun textingLevels() {
        val c = listOf(Contact("1", "Mom", "5550102231", always = true))
        val f = listOf(Friend("f", "Ava", "5550142290"))
        assertEquals(TextRules.SHOWN, TextRules.status(listOf("5550142290"), TextRules.People(c, f, emptyList()), false))
        assertEquals(TextRules.HELD, TextRules.status(listOf("5550142290"), TextRules.People(c, f, emptyList(), "family"), false))
        assertEquals(TextRules.HELD, TextRules.status(listOf("5559990000"), TextRules.People(c, f, emptyList()), false))
        assertEquals(TextRules.SHOWN, TextRules.status(listOf("5559990000"), TextRules.People(c, f, emptyList(), "anyone"), false))
        assertEquals(TextRules.BLOCKED, TextRules.status(listOf("5559990000"), TextRules.People(c, f, listOf("5559990000"), "anyone"), false))
    }
}
