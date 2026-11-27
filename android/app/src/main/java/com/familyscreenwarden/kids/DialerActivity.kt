package com.familyscreenwarden.kids

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Toast

/**
 * Android sends "dial this number" here, because Family Screen Warden is the phone app. Family contacts and the emergency
 * number are called; anything else opens the launcher's family list (kids call the people their family listed).
 */
class DialerActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Kids.init(this)
        val n = intent?.data?.schemeSpecificPart?.trim().orEmpty()
        val emergency = Kids.snap?.phone?.rules?.emergencyNumber ?: "911"
        val family = Kids.snap?.phone?.contacts?.firstOrNull { Phone.same(it.phone, n) }
        when {
            n.filter { it.isDigit() } == emergency.filter { it.isDigit() } && n.isNotEmpty() -> Phone.emergency(this, emergency)
            family != null && (!Kids.lockedNow || family.always) -> { Calls.dialing(family.phone); Phone.call(this, family.phone) }
            else -> {
                if (n.isNotEmpty()) Toast.makeText(this, "Kids can call the family contacts in the launcher.", Toast.LENGTH_SHORT).show()
                startActivity(Intent(this, LauncherActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
            }
        }
        finish()
    }
}
