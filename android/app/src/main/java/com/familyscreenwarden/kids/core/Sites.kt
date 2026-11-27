package com.familyscreenwarden.kids.core

import java.time.LocalTime

object Sites {
    fun normalize(host: String): String {
        var h = host.trim().lowercase().trimEnd('.')
        if (h.startsWith("www.")) h = h.substring(4)
        return h
    }

    fun inWindow(from: String?, to: String?, t: LocalTime): Boolean {
        val f = try { LocalTime.parse(from) } catch (_: Exception) { return true }
        val e = try { LocalTime.parse(to) } catch (_: Exception) { return true }
        return if (f <= e) t >= f && t < e else t >= f || t < e
    }

    /** The hosts allowed right now ("khanacademy.org" also allows its subdomains), for Chrome's allow list. */
    fun allowedNow(rules: List<SiteRule>, t: LocalTime): List<String> =
        rules.filter { normalize(it.host).isNotEmpty() && inWindow(it.from, it.to, t) }.map { normalize(it.host) }.distinct()
}
