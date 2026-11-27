package com.familyscreenwarden.kids.core

/**
 * Who the kid can text (the texting app). Family contacts any time ("always" ones even at bedtime and when time's up),
 * friends a grown-up said yes to (not then: those texts wait). Anyone else: held for the grown-ups. Blocked: dropped.
 */
object TextRules {
    const val SHOWN = "shown"
    const val WAITING = "waiting"
    const val HELD = "held"
    const val BLOCKED = "blocked"

    /** The part of a number that identifies it (the server's numKey): digits, the last 10 when there are more. */
    fun key(n: String?): String {
        val d = n.orEmpty().filter { it.isDigit() }
        return if (d.length > 10) d.takeLast(10) else d
    }

    class People(contacts: List<Contact>, friends: List<Friend>, blocked: List<String>) {
        val family = contacts.associateBy { key(it.phone) }.filterKeys { it.isNotEmpty() }
        val friends = friends.associateBy { key(it.phone) }.filterKeys { it.isNotEmpty() }
        val blocked = blocked.map { key(it) }.toSet()
        fun name(k: String): String? = family[k]?.name ?: friends[k]?.name
        fun known(k: String) = k in family || k in friends
    }

    /** What the kid sees of a chat with these people (numbers' keys, not the kid's own). */
    fun status(parts: Collection<String>, p: People, locked: Boolean): String = when {
        parts.isEmpty() -> HELD
        parts.any { it in p.blocked } -> BLOCKED
        parts.any { !p.known(it) } -> HELD
        locked && parts.any { k -> p.family[k]?.always != true } -> WAITING
        else -> SHOWN
    }

    /** The thread a set of people make: their keys, sorted, joined. */
    fun thread(parts: Collection<String>) = parts.map { key(it) }.filter { it.isNotEmpty() }.toSortedSet().joinToString(",")
}
