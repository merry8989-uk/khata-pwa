plugins {
    id("com.android.application")
}

/**
 * The release keystore never lives in the repository. CI decodes it from the
 * ANDROID_KEYSTORE_BASE64 secret into android/khata-release.p12 and passes the
 * password through the environment. Without those variables a release build is
 * unsigned, which is a failure, not a fallback - see .github/workflows/release.yml.
 */
val keystorePath: String? = System.getenv("KEYSTORE_FILE")

android {
    namespace = "io.github.merry8989uk.khata"
    compileSdk = 34

    defaultConfig {
        applicationId = "io.github.merry8989uk.khata"
        minSdk = 24
        targetSdk = 34
        versionCode = (project.findProperty("khataVersionCode") as String?)?.toIntOrNull() ?: 1
        versionName = (project.findProperty("khataVersionName") as String?) ?: "1.0.0"
    }

    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                // Resolved against android/, where CI writes it, not against app/.
                storeFile = rootProject.file(keystorePath)
                storeType = "PKCS12"
                storePassword = System.getenv("KEYSTORE_PASSWORD")
                keyAlias = System.getenv("KEY_ALIAS")
                keyPassword = System.getenv("KEY_PASSWORD")
                enableV1Signing = true
                enableV2Signing = true
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            signingConfig = if (keystorePath != null) signingConfigs.getByName("release") else null
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }

    lint {
        abortOnError = false
    }
}

// No third-party dependencies: the shell is a WebView, MediaStore downloads and
// the platform installer. Fewer moving parts, smaller APK, nothing to audit.
