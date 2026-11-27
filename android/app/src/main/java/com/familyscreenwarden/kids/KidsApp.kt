package com.familyscreenwarden.kids

import android.app.Application

class KidsApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Kids.init(this)
        KidsService.start(this)
    }
}
