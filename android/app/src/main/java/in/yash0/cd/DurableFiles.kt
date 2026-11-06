package `in`.yash0.cd

import android.system.Os
import android.system.OsConstants
import java.io.File

object DurableFiles {
    fun directory(directory: File) {
        val descriptor = Os.open(directory.absolutePath, OsConstants.O_RDONLY, 0)
        try { Os.fsync(descriptor) } finally { Os.close(descriptor) }
    }
}
