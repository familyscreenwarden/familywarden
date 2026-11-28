package com.familyscreenwarden.kids.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import java.io.ByteArrayOutputStream

class TextRulesTest {
    private val people = TextRules.People(
        contacts = listOf(Contact("1", "Mom", "(555) 010-2231", always = true), Contact("2", "Uncle Ben", "555-010-9999", always = false)),
        friends = listOf(Friend("f", "Ava", "+1 555 014 2290")),
        blocked = listOf("5550197733"),
    )

    @Test fun numbersMatchHowever() {
        assertEquals("5550102231", TextRules.key("+1 (555) 010-2231"))
        assertEquals("5550102231,5550142290", TextRules.thread(listOf("+15550142290", "555.010.2231", "5550142290")))
    }

    @Test fun whoCanText() {
        assertEquals(TextRules.SHOWN, TextRules.status(listOf("5550102231"), people, locked = false))
        assertEquals(TextRules.SHOWN, TextRules.status(listOf("5550102231", "5550142290"), people, locked = false))
        // Bedtime: only "always" family.
        assertEquals(TextRules.SHOWN, TextRules.status(listOf("5550102231"), people, locked = true))
        assertEquals(TextRules.WAITING, TextRules.status(listOf("5550142290"), people, locked = true))
        assertEquals(TextRules.WAITING, TextRules.status(listOf("5550109999"), people, locked = true))
        assertEquals(TextRules.WAITING, TextRules.status(listOf("5550102231", "5550142290"), people, locked = true))
        // A stranger anywhere in the chat: held. Blocked beats that.
        assertEquals(TextRules.HELD, TextRules.status(listOf("5550102231", "5551112222"), people, locked = false))
        assertEquals(TextRules.BLOCKED, TextRules.status(listOf("5550197733"), people, locked = false))
        assertEquals("Ava", people.name("5550142290"))
    }
}

class MmsTest {
    @Test fun aGroupPictureTextRoundTrips() {
        val jpg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 1, 2, 3)
        val pdu = Mms.sendReq("T123", listOf("+15550102231", "5550142290"), "Look! 🐱", listOf(Mms.Part("image/jpeg", jpg)), 1_800_000_000)
        val m = Mms.parse(pdu)
        assertNotNull(m)
        assertEquals(Mms.SEND_REQ, m!!.type)
        assertEquals("T123", m.transactionId)
        assertEquals(listOf("+15550102231", "5550142290"), m.to)
        assertEquals(1_800_000_000L, m.dateSec)
        assertEquals("Look! 🐱", m.text)
        assertEquals(1, m.media.size)
        assertEquals("image/jpeg", m.media[0].type)
        assertArrayEquals(jpg, m.media[0].data)
    }

    @Test fun readsANotice() {
        val o = ByteArrayOutputStream()
        o.write(0x8C); o.write(0x82)
        o.write(0x98); o.write("abc1".toByteArray()); o.write(0)
        o.write(0x8D); o.write(0x92)
        o.write(0x89); val from = "+15550102231/TYPE=PLMN".toByteArray(); o.write(from.size + 2); o.write(0x80); o.write(from); o.write(0)
        o.write(0x8E); o.write(2); o.write(0x30); o.write(0x39)
        o.write(0x83); o.write("http://mmsc.example/x?id=1".toByteArray()); o.write(0)
        val m = Mms.parse(o.toByteArray())!!
        assertEquals(Mms.NOTIFICATION_IND, m.type)
        assertEquals("abc1", m.transactionId)
        assertEquals("+15550102231", m.from)
        assertEquals("http://mmsc.example/x?id=1", m.contentLocation)
        assertEquals(0x3039L, m.size)
    }

    @Test fun readsADownloadedGroupText() {
        val o = ByteArrayOutputStream()
        o.write(0x8C); o.write(0x84)
        o.write(0x8D); o.write(0x92)
        o.write(0x85); o.write(4); o.write(byteArrayOf(0x6B, 0x49, 0xD2.toByte(), 0x00))
        // From with a charset (utf-8 = 106).
        val from = "5550142290/TYPE=PLMN".toByteArray()
        o.write(0x89); o.write(from.size + 4); o.write(0x80); o.write(from.size + 2); o.write(0xEA); o.write(from); o.write(0)
        o.write(0x97); o.write("+15550102231/TYPE=PLMN".toByteArray()); o.write(0)
        o.write(0x97); o.write("+15559990000/TYPE=PLMN".toByteArray()); o.write(0)
        o.write(0x82); o.write("5550109999/TYPE=PLMN".toByteArray()); o.write(0)
        o.write(0x84); o.write(1); o.write(0xA3) // multipart/mixed
        Mms.uintvar(o, 2)
        val txt = "hi all".toByteArray()
        val h1 = byteArrayOf(3, 0x83.toByte(), 0x81.toByte(), 0xEA.toByte())
        Mms.uintvar(o, h1.size.toLong()); Mms.uintvar(o, txt.size.toLong()); o.write(h1); o.write(txt)
        val img = ByteArray(300) { it.toByte() }
        val h2 = byteArrayOf(0x9E.toByte(), 0x8E.toByte()) + "a.jpg".toByteArray() + byteArrayOf(0)
        Mms.uintvar(o, h2.size.toLong()); Mms.uintvar(o, img.size.toLong()); o.write(h2); o.write(img)
        val m = Mms.parse(o.toByteArray())!!
        assertEquals(Mms.RETRIEVE_CONF, m.type)
        assertEquals("5550142290", m.from)
        assertEquals(listOf("+15550102231", "+15559990000"), m.to)
        assertEquals(listOf("5550109999"), m.cc)
        assertEquals(0x6B49D200L, m.dateSec)
        assertEquals("hi all", m.text)
        assertEquals("a.jpg", m.media[0].name)
        assertArrayEquals(img, m.media[0].data)
    }

    @Test fun saysGotIt() {
        val m = Mms.parse(Mms.notifyResp("abc1"))!!
        assertEquals(Mms.NOTIFYRESP_IND, m.type)
        assertEquals("abc1", m.transactionId)
    }
}
