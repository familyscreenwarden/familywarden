package com.familyscreenwarden.kids

import android.content.ContentProviderOperation
import android.content.Context
import android.provider.ContactsContract
import android.provider.ContactsContract.CommonDataKinds
import android.util.Log
import com.familyscreenwarden.kids.core.Contact

/**
 * The family contacts from Family Screen Warden, copied into the phone's own contacts (so texts and anything else on the phone
 * show "Mom", not a number). Each one is tagged screenwarden:<id>; they're updated when the server's list changes and
 * removed when a parent removes them. Contacts the kid or anyone else added aren't touched.
 */
object Contacts {
    private var last = ""
    private const val TAG = "screenwarden:"

    fun sync(ctx: Context, list: List<Contact>) {
        val key = list.joinToString("|") { "${it.id}:${it.name}:${it.phone}" }
        if (key == last) return
        try {
            val cr = ctx.contentResolver
            val mine = HashMap<String, Long>()
            cr.query(ContactsContract.RawContacts.CONTENT_URI, arrayOf(ContactsContract.RawContacts._ID, ContactsContract.RawContacts.SOURCE_ID),
                "${ContactsContract.RawContacts.SOURCE_ID} LIKE ? AND ${ContactsContract.RawContacts.DELETED} = 0", arrayOf("$TAG%"), null)?.use { c ->
                while (c.moveToNext()) mine[c.getString(1)] = c.getLong(0)
            }
            val ops = ArrayList<ContentProviderOperation>()
            // Gone from Family Screen Warden: removed from the phone.
            for ((src, id) in mine) if (list.none { TAG + it.id == src })
                ops += ContentProviderOperation.newDelete(ContactsContract.RawContacts.CONTENT_URI.buildUpon().appendQueryParameter(ContactsContract.CALLER_IS_SYNCADAPTER, "true").build())
                    .withSelection("${ContactsContract.RawContacts._ID} = ?", arrayOf(id.toString())).build()
            for (c in list) {
                val existing = mine[TAG + c.id]
                if (existing != null) {
                    // Same contact: replace its name and number.
                    ops += ContentProviderOperation.newDelete(ContactsContract.Data.CONTENT_URI)
                        .withSelection("${ContactsContract.Data.RAW_CONTACT_ID} = ? AND ${ContactsContract.Data.MIMETYPE} IN (?, ?)",
                            arrayOf(existing.toString(), CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE, CommonDataKinds.Phone.CONTENT_ITEM_TYPE)).build()
                    ops += ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI).withValue(ContactsContract.Data.RAW_CONTACT_ID, existing)
                        .withValue(ContactsContract.Data.MIMETYPE, CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE).withValue(CommonDataKinds.StructuredName.DISPLAY_NAME, c.name).build()
                    ops += ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI).withValue(ContactsContract.Data.RAW_CONTACT_ID, existing)
                        .withValue(ContactsContract.Data.MIMETYPE, CommonDataKinds.Phone.CONTENT_ITEM_TYPE).withValue(CommonDataKinds.Phone.NUMBER, c.phone)
                        .withValue(CommonDataKinds.Phone.TYPE, CommonDataKinds.Phone.TYPE_MOBILE).build()
                } else {
                    val at = ops.size
                    ops += ContentProviderOperation.newInsert(ContactsContract.RawContacts.CONTENT_URI)
                        .withValue(ContactsContract.RawContacts.ACCOUNT_TYPE, null).withValue(ContactsContract.RawContacts.ACCOUNT_NAME, null)
                        .withValue(ContactsContract.RawContacts.SOURCE_ID, TAG + c.id).build()
                    ops += ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI).withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, at)
                        .withValue(ContactsContract.Data.MIMETYPE, CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE).withValue(CommonDataKinds.StructuredName.DISPLAY_NAME, c.name).build()
                    ops += ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI).withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, at)
                        .withValue(ContactsContract.Data.MIMETYPE, CommonDataKinds.Phone.CONTENT_ITEM_TYPE).withValue(CommonDataKinds.Phone.NUMBER, c.phone)
                        .withValue(CommonDataKinds.Phone.TYPE, CommonDataKinds.Phone.TYPE_MOBILE).build()
                }
            }
            if (ops.isNotEmpty()) cr.applyBatch(ContactsContract.AUTHORITY, ops)
            last = key
        } catch (e: Exception) {
            Log.w(Kids.TAG, "contacts: ${e.message}")
        }
    }
}
