package com.yashasvm.cd.sample

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.nio.file.Files

class ReceiveToCacheTest {
    @Test fun successfulReceivesKeepSeparateFiles() = runBlocking {
        val cache = Files.createTempDirectory("cd-cache-test").toFile()
        try {
            val first = receiveToCache(cache) { it.writeText("first verified file") }
            val second = receiveToCache(cache) { it.writeText("second verified file") }
            assertTrue(first != second)
            assertEquals("first verified file", first.readText())
            assertEquals("second verified file", second.readText())
        } finally { cache.deleteRecursively() }
    }

    @Test fun failureDeletesPartialOutput() = runBlocking { assertCleanup(IOException("network lost")) }

    @Test fun cancellationDeletesPartialOutput() = runBlocking { assertCleanup(CancellationException("cancelled")) }

    private suspend fun assertCleanup(failure: Exception) {
        val cache = Files.createTempDirectory("cd-cache-test").toFile()
        try {
            val previous = receiveToCache(cache) { it.writeText("previous verified file") }
            try {
                receiveToCache(cache) {
                    it.writeText("partial bytes")
                    throw failure
                }
                fail("The receive must propagate its failure")
            } catch (actual: Exception) { assertSame(failure, actual) }
            assertEquals(listOf(previous), cache.listFiles()!!.toList())
            assertEquals("previous verified file", previous.readText())
        } finally { cache.deleteRecursively() }
    }
}
