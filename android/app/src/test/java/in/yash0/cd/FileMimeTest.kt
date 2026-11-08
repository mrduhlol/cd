package `in`.yash0.cd

import org.junit.Assert.assertEquals
import org.junit.Test

class FileMimeTest {
    @Test fun keepsApkTypeForDuplicateAndUppercaseNames() {
        for (name in listOf("app-debug.apk", "app-debug (14).apk", "APP.APK")) {
            assertEquals("application/vnd.android.package-archive", fileMime(name) { null })
        }
    }
    @Test fun resolvesOtherFilesAndFallsBackForUnknownExtensions() {
        assertEquals("application/pdf", fileMime("report (2).PDF") { if (it == "pdf") "application/pdf" else null })
        assertEquals("application/octet-stream", fileMime("unknown") { null })
    }
}
