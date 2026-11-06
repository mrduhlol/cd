buildscript {
    if (providers.gradleProperty("cdFcm").orNull == "true" && providers.gradleProperty("cdFcmCompileOnly").orNull != "true") {
        repositories { google(); mavenCentral() }
        dependencies { classpath("com.google.gms:google-services:4.5.0") }
    }
}
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}
val cdFcmValue = providers.gradleProperty("cdFcm").orNull
require(cdFcmValue == null || cdFcmValue in setOf("true", "false")) { "cdFcm must be true or false" }
val cdFcm = cdFcmValue == "true"
val cdFcmCompileOnlyValue = providers.gradleProperty("cdFcmCompileOnly").orNull
require(cdFcmCompileOnlyValue == null || cdFcmCompileOnlyValue in setOf("true", "false")) { "cdFcmCompileOnly must be true or false" }
val cdFcmCompileOnly = cdFcmCompileOnlyValue == "true"
require(!cdFcmCompileOnly || cdFcm) { "cdFcmCompileOnly requires cdFcm=true" }
if (cdFcmCompileOnly) gradle.taskGraph.whenReady {
    require(allTasks.none { it.name.startsWith("assemble") || it.name.matches(Regex("package(Debug|Release)(Bundle)?")) || it.name.matches(Regex("bundle(Debug|Release)")) || it.name.startsWith("install") }) { "cdFcmCompileOnly permits compilation, unit tests and lint only. Configure google-services.json before packaging an APK." }
}
if (cdFcm && !cdFcmCompileOnly) {
    require(file("google-services.json").isFile) { "cdFcm=true requires android/app/google-services.json from your Firebase Android app (in.yash0.cd). See android/docs/push.md." }
    apply(plugin = "com.google.gms.google-services")
}
val cdAbi = providers.gradleProperty("cdAbi").orNull
require(cdAbi == null || cdAbi in setOf("arm64-v8a", "armeabi-v7a", "x86", "x86_64")) { "cdAbi must be arm64-v8a, armeabi-v7a, x86, or x86_64" }
val cdApplicationId = "in.yash0.cd.beta"
android {
    namespace = "in.yash0.cd"
    compileSdk = 35
    defaultConfig { applicationId = cdApplicationId; manifestPlaceholders["cdTargetPackage"] = cdApplicationId; manifestPlaceholders["cdAppLabel"] = "CD Beta"; manifestPlaceholders["cdPairScheme"] = "cdpair-beta"; manifestPlaceholders["cdWebHost"] = "cd.yash0.in"; minSdk = 29; targetSdk = 35; versionCode = 6; versionName = "0.1.5-beta"; if (cdAbi != null) ndk { abiFilters += cdAbi } }
    buildFeatures { compose = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    sourceSets["main"].java.srcDir(if (cdFcm) "src/fcm/kotlin" else "src/noFcm/kotlin")
    if (cdFcm) {
        val pushManifest = layout.buildDirectory.file("generated/fcm/AndroidManifest.xml")
        val generatePushManifest = tasks.register("generatePushManifest") {
            inputs.files("src/main/AndroidManifest.xml", "src/fcm/AndroidManifest.xml")
            outputs.file(pushManifest)
            doLast {
                val additions = file("src/fcm/AndroidManifest.xml").readText().substringAfter("<application>").substringBefore("</application>")
                pushManifest.get().asFile.apply { parentFile.mkdirs(); writeText(file("src/main/AndroidManifest.xml").readText().replace("</application>", additions + "</application>")) }
            }
        }
        sourceSets["main"].manifest.srcFile(pushManifest)
        tasks.named("preBuild").configure { dependsOn(generatePushManifest) }
    }
    sourceSets["test"].resources.srcDir("../../fixtures")
}
dependencies {
    implementation(platform("androidx.compose:compose-bom:2025.01.01"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.activity:activity-compose:1.10.0")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    if (cdFcm) {
        implementation("com.google.firebase:firebase-messaging:26.0.0")
        constraints { implementation("androidx.fragment:fragment:1.8.6") { because("Play services requests Fragment 1.1; Activity Result APIs require 1.3 or newer") } }
    }
    implementation("io.github.webrtc-sdk:android:150.7871.01")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.json:json:20240303")
}
