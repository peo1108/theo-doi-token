import java.io.File
import java.util.Base64
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// ---- Ký bản release ----
// 1) CI: biến môi trường ANDROID_KEYSTORE_B64 (keystore base64), ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD
// 2) Máy local: %USERPROFILE%\.ccremote\android-signing.properties (storeFile, storePassword, keyAlias, keyPassword)
// Thiếu cả hai: ký bằng khoá debug và in cảnh báo (bản đó KHÔNG cài đè được bản ký khoá thật).
data class Sign(val file: File, val storePassword: String, val alias: String, val keyPassword: String, val source: String)

fun loadSigning(): Sign? {
    val b64 = System.getenv("ANDROID_KEYSTORE_B64")?.trim().orEmpty()
    val sp = System.getenv("ANDROID_KEYSTORE_PASSWORD").orEmpty()
    val alias = System.getenv("ANDROID_KEY_ALIAS").orEmpty()
    val kp = System.getenv("ANDROID_KEY_PASSWORD").orEmpty()
    if (b64.isNotEmpty() && sp.isNotEmpty() && alias.isNotEmpty()) {
        val out = layout.buildDirectory.file("signing/release.jks").get().asFile
        out.parentFile.mkdirs()
        out.writeBytes(Base64.getMimeDecoder().decode(b64))
        return Sign(out, sp, alias, kp.ifEmpty { sp }, "biến môi trường")
    }
    val props = File(System.getProperty("user.home"), ".ccremote/android-signing.properties")
    if (props.isFile) {
        val p = Properties().apply { props.inputStream().use { load(it) } }
        val f = File(p.getProperty("storeFile", ""))
        if (f.isFile && p.getProperty("storePassword") != null && p.getProperty("keyAlias") != null) {
            val spw = p.getProperty("storePassword")
            return Sign(f, spw, p.getProperty("keyAlias"), p.getProperty("keyPassword") ?: spw, props.path)
        }
    }
    return null
}

val signing = loadSigning()

android {
    namespace = "vn.peo.ccremote"
    compileSdk = 37

    defaultConfig {
        applicationId = "vn.peo.ccremote"
        minSdk = 26
        targetSdk = 36
        // CI: versionCode = github.run_number (cài đè được bản cũ); local = 1
        versionCode = System.getenv("VERSION_CODE")?.toIntOrNull() ?: 1
        versionName = "1.2.0"
    }

    signingConfigs {
        if (signing != null) {
            create("release") {
                storeFile = signing.file
                storePassword = signing.storePassword
                keyAlias = signing.alias
                keyPassword = signing.keyPassword
            }
        }
    }

    buildTypes {
        // như debug (có DebugHooks để smoke test) nhưng chạy R8 giống release: kiểm tra quy tắc proguard / kotlinx.serialization
        create("minified") {
            initWith(getByName("debug"))
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            matchingFallbacks += "debug"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (signing != null) {
                signingConfig = signingConfigs.getByName("release")
            } else {
                signingConfig = signingConfigs.getByName("debug")
                if (gradle.startParameter.taskNames.any { it.contains("release", ignoreCase = true) }) {
                    logger.warn("CẢNH BÁO: không có khoá ký release (ANDROID_KEYSTORE_* hoặc ~/.ccremote/android-signing.properties) — ký bằng khoá debug.")
                }
            }
        }
    }

    sourceSets.getByName("minified") {
        java.srcDir("src/debug/java")
        res.srcDir("src/debug/res")
        manifest.srcFile("src/debug/AndroidManifest.xml")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        freeCompilerArgs.addAll("-opt-in=androidx.compose.material3.ExperimentalMaterial3Api", "-opt-in=androidx.compose.foundation.ExperimentalFoundationApi")
    }
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.text)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
