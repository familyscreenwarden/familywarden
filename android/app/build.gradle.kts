plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// Family Screen Warden: the kids' phone app (device owner). Version = VERSION (major.minor) + the GitHub run number.
// Release signing comes from environment variables (GitHub Actions secrets), never from the repo. Phones set up with
// this app only take updates signed with the SAME key, so the key must never change (see README.md).
val keystorePath: String? = System.getenv("ANDROID_KEYSTORE_FILE")
val hasReleaseKey = !keystorePath.isNullOrBlank() && file(keystorePath!!).exists()
val runNumber = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
val baseVersion = rootProject.file("VERSION").readText().trim()

android {
    namespace = "com.familyscreenwarden.kids"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.familyscreenwarden.kids"
        minSdk = 28
        targetSdk = 36
        versionCode = runNumber
        versionName = "$baseVersion.$runNumber"
    }

    signingConfigs {
        if (hasReleaseKey) {
            create("release") {
                storeFile = file(keystorePath!!)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (hasReleaseKey) signingConfig = signingConfigs.getByName("release")
        }
    }

    sourceSets {
        // The launcher page lives in ../launcher (shared with the Windows app), copied in at build time: one launcher.
        getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/launcherAssets"))
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

val copyLauncher by tasks.registering(Copy::class) {
    from(rootProject.file("../launcher"))
    into(layout.buildDirectory.dir("generated/launcherAssets/launcher"))
}
tasks.named("preBuild") { dependsOn(copyLauncher) }

dependencies {
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.1")
    implementation("androidx.webkit:webkit:1.13.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    testImplementation("junit:junit:4.13.2")
}
