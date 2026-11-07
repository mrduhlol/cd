package `in`.yash0.cd.ui

import `in`.yash0.cd.Direction
import `in`.yash0.cd.TransferPhase
import `in`.yash0.cd.TransferView
import org.junit.Assert.assertEquals
import org.junit.Test

class FormatTest {
    private val mb = 1024L * 1024

    @Test fun sizesMatchWebsite() {
        assertEquals("512 B", Format.size(512))
        assertEquals("1.5 KB", Format.size(1536))
        assertEquals("742.0 MB", Format.size(742 * mb))
        assertEquals("2.50 GB", Format.size(2560 * mb))
        assertEquals("–", Format.size(-1))
    }

    @Test fun etaMatchesWebsite() {
        assertEquals("<1s", Format.eta(0.4))
        assertEquals("5s", Format.eta(4.2))
        assertEquals("2m 5s", Format.eta(125.0))
        assertEquals("1h 1m", Format.eta(3700.0))
        assertEquals("–", Format.eta(Double.NaN))
    }

    @Test fun speedPartsScale() {
        assertEquals("0" to "MB/s", Format.speedParts(0.0))
        assertEquals("512" to "KB/s", Format.speedParts(512.0 * 1024))
        assertEquals("86.0" to "MB/s", Format.speedParts(86.0 * mb))
        assertEquals(100.0, Format.gaugeScale(80.0 * mb), 0.0)
        assertEquals(250.0, Format.gaugeScale(86.0 * mb), 0.0)
        assertEquals(5.0, Format.gaugeScale(1.0 * mb), 0.0)
    }

    @Test fun fractionAndEtaFromView() {
        val v = TransferView("a", Direction.RECEIVE, "f", 100 * mb, 25 * mb, 25 * mb, TransferPhase.TRANSFERRING)
        assertEquals(0.25f, Format.fraction(v), 0.0001f)
        assertEquals("3s", Format.eta(v))
        assertEquals(1f, Format.fraction(v.copy(phase = TransferPhase.COMPLETE)), 0f)
        assertEquals(0f, Format.fraction(v.copy(size = -1)), 0f)
    }

    @Test fun shortenMiddleKeepsExtension() {
        assertEquals("short.txt", Format.shortenMiddle("short.txt"))
        val s = Format.shortenMiddle("a-very-long-file-name-that-keeps-going-forever.tar.gz", 20)
        assertEquals(20, s.length)
        assert(s.endsWith(".tar.gz"))
    }
}
