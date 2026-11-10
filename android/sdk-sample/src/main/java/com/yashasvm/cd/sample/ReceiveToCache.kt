package com.yashasvm.cd.sample

import java.io.File
import java.io.IOException

internal suspend fun receiveToCache(cacheDir: File, receive: suspend (File) -> Unit): File {
    val output = File.createTempFile("cd-received-", ".part", cacheDir)
    try {
        receive(output)
        return output
    } catch (failure: Throwable) {
        if (!output.delete()) failure.addSuppressed(IOException("Could not remove incomplete cache output"))
        throw failure
    }
}
