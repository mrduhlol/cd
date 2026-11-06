package `in`.yash0.cd

import java.util.Locale

internal fun fileMime(filename: String, lookup: (String) -> String?): String {
    val extension = filename.substringAfterLast('.', "").lowercase(Locale.ROOT)
    return if (extension == "apk") "application/vnd.android.package-archive"
    else lookup(extension) ?: "application/octet-stream"
}
