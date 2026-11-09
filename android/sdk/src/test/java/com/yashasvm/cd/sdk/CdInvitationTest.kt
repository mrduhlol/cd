package com.yashasvm.cd.sdk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class CdInvitationTest {
    @Test fun invitationRoundTripsOnlyOnConfiguredOrigin() {
        val invite = CdInvitation.create("https://cd.yash0.in", ByteArray(48) { it.toByte() })
        val parsed = CdInvitation.parse(invite.url, "https://cd.yash0.in")
        assertEquals(invite.url, parsed.url)
        assertEquals(16, parsed.transferId.size)
        assertEquals(32, parsed.key.size)
        assertThrows(IllegalArgumentException::class.java) { CdInvitation.parse(invite.url, "https://attacker.example") }
    }

    @Test fun malformedAndNonCanonicalCredentialsAreRejected() {
        assertThrows(IllegalArgumentException::class.java) {
            CdInvitation.parse("https://cd.yash0.in/s/short#v1.short", "https://cd.yash0.in")
        }
        assertThrows(IllegalArgumentException::class.java) {
            CdInvitation.create("https://cd.yash0.in", ByteArray(47))
        }
    }
}
