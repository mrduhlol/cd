package `in`.yash0.cd.ui

import `in`.yash0.cd.Direction
import `in`.yash0.cd.TransferPhase
import `in`.yash0.cd.TransferView
import org.junit.Assert.*
import org.junit.Test

class TransferUiTest {
    private val now = 1000L
    private val link = "https://example.test/s/root#private-capability"
    private fun send(phase: TransferPhase = TransferPhase.WAITING) = TransferView(
        "root", Direction.SEND, "file.txt", 100, 0, 0, phase, link = link, expiresAt = 2000,
    )

    @Test fun unacceptedSendHasNoInvitation() {
        val view = send(TransferPhase.CONNECTING).copy(link = null, expiresAt = 0)
        assertEquals(ShareState.Preparing, shareState(view, now))
        assertEquals(TransferBody.PREPARING, transferBody(view, now))
        assertNull(liveLink(view, now))
    }

    @Test fun acceptedInvitationSurvivesRepeatedPauseAndReconnect() {
        for (phase in listOf(TransferPhase.WAITING, TransferPhase.PAUSED, TransferPhase.RETRYING,
            TransferPhase.CONNECTING, TransferPhase.WAITING, TransferPhase.PAUSED)) {
            val view = send(phase).copy(message = "Connection interrupted")
            assertEquals(link, shareState(view, now).link)
            assertEquals(link, liveLink(view, now))
            assertEquals(TransferBody.SHARE, transferBody(view, now))
            if (phase == TransferPhase.WAITING) assertEquals(ShareState.Ready(link), shareState(view, now))
            else assertTrue(shareState(view, now) is ShareState.Offline)
        }
        assertEquals("Not connected — resume to accept the receiver", offlineLabel(ShareState.Offline(link, true, null)))
        assertEquals("Reconnecting — the link stays the same", offlineLabel(ShareState.Offline(link, false, null)))
    }

    @Test fun expiryAndTerminalPhasesHideCapabilities() {
        for (phase in TransferPhase.entries) {
            val expired = send(phase)
            assertEquals(ShareState.Hidden, shareState(expired, 2000))
            assertNull(liveLink(expired, 2000))
        }
        for (phase in listOf(TransferPhase.COMPLETE, TransferPhase.CANCELLED, TransferPhase.FAILED)) {
            assertEquals(ShareState.Hidden, shareState(send(phase), now))
            assertNull(liveLink(send(phase), now))
            assertEquals(TransferBody.RESULT, transferBody(send(phase), now))
        }
    }

    @Test fun progressedSendUsesProgressButStillAllowsValidLink() {
        val view = send(TransferPhase.PAUSED).copy(done = 25)
        assertEquals(TransferBody.PROGRESS, transferBody(view, now))
        assertEquals(link, liveLink(view, now))
    }

    @Test fun receiveNeverShowsSendCapabilityAndLookupUsesDirection() {
        val sent = send()
        val received = sent.copy(direction = Direction.RECEIVE)
        val views = listOf(received, sent)
        assertEquals(sent, views.findTransfer("root", Direction.SEND))
        assertEquals(received, views.findTransfer("root", Direction.RECEIVE))
        assertNull(views.findTransfer("absent", Direction.SEND))
        assertEquals(ShareState.Hidden, shareState(received, now))
        assertNull(liveLink(received, now))
        assertEquals("waiting for receiver", Format.phase(sent))
        assertEquals("queued", Format.phase(received))
        assertEquals("Sent", transferTitle(sent.copy(phase = TransferPhase.COMPLETE), now))
        assertEquals("Saved", transferTitle(received.copy(phase = TransferPhase.COMPLETE), now))
    }

    @Test fun navigationRoundTripRestoresTabDirectionAndBackStack() {
        val original = UiState().apply {
            tab = Tab.TRANSFERS
            open(Screen.Transfer("root_12-AB", Direction.RECEIVE))
            open(Screen.Settings)
            input = link
        }
        val saved = original.saveNav()
        assertFalse(saved.contains(link))
        assertFalse(saved.contains("private-capability"))
        val restored = UiState().apply { restoreNav(saved) }
        assertEquals(Tab.TRANSFERS, restored.tab)
        assertEquals(Screen.Settings, restored.screen)
        assertEquals("", restored.input)
        assertTrue(restored.back())
        assertEquals(Screen.Transfer("root_12-AB", Direction.RECEIVE), restored.screen)
        assertTrue(restored.back())
        assertEquals(Screen.Home, restored.screen)
        assertTrue(restored.back())
        assertEquals(Tab.SEND, restored.tab)
        assertFalse(restored.back())
    }

    @Test fun malformedNavigationRestoresSafeHome() {
        for (raw in listOf(null, "", "nav2\nSEND\nhome", "nav1\nOTHER\nhome", "nav1\nSEND\nsettings",
            "nav1\nSEND\nhome\nhome", "nav1\nSEND\nhome\ntransfer:SEND:%GG",
            "nav1\nSEND\nhome\ntransfer:OTHER:root", "nav1\nSEND\nhome\ntransfer:SEND:",
            "nav1\nSEND\nhome\ntransfer:SEND:https%3A%2F%2Fprivate", "nav1\nSEND\nhome" + "\nsettings".repeat(16))) {
            assertEquals(raw, NavCodec.Default, NavCodec.decode(raw))
        }
        assertEquals(NavCodec.Default, NavCodec.decode(NavCodec.encode(Tab.RECEIVE, listOf(Screen.Home, Screen.Transfer(link, Direction.SEND)))))
    }

    @Test fun codeSendSharesTheCodeAndNeverOffersItsUrlAsPrivate() {
        val codeUrl = "https://cd.yash0.in/#48213"
        val view = send().copy(link = codeUrl, code = "48213", privateLink = link, isPrivate = false, codeExpiresAt = 1500, expiresAt = 90_000)
        assertEquals("48213", liveCode(view, now))
        assertEquals(codeUrl, liveLink(view, now))
        assertNull(privateOffer(view, now))
        assertEquals("cdx receive 48213", receiveCommand(codeUrl, "48213"))
        assertTrue(shareText(codeUrl, "48213").contains("48213"))
        assertFalse(privacyNote(false, "48213").contains("end-to-end"))
        assertEquals(1500, nextDeadline(view, now))
        // Spent once bytes move, gone once finished.
        assertNull(liveCode(view.copy(done = 1, phase = TransferPhase.TRANSFERRING), now))
        assertNull(liveCode(view.copy(phase = TransferPhase.COMPLETE), now))
    }

    @Test fun codeSendNeverFallsBackToTheLongTransferUrl() {
        val view = send().copy(link = "https://cd.yash0.in/#48213", code = "48213", privateLink = link, isPrivate = false, codeExpiresAt = 1500, expiresAt = 90_000)
        // Code expired, backend not paused yet: no code, no URL, and not "Getting a code…".
        assertNull(liveCode(view, 1600))
        assertNull(liveLink(view, 1600))
        assertNull(privateOffer(view, 1600))
        assertTrue(codeExpired(view, 1600))
        assertEquals(TransferBody.CODE_EXPIRED, transferBody(view, 1600))
        assertEquals("Code expired", transferTitle(view, 1600))
        assertEquals(90_000, nextDeadline(view, 1600))
        // Backend paused it and cleared the code: still nothing to share, Resume is the way on.
        val paused = view.copy(code = null, link = null, phase = TransferPhase.PAUSED)
        assertNull(liveLink(paused, 1600))
        assertNull(privateOffer(paused, 1600))
        assertEquals(TransferBody.CODE_EXPIRED, transferBody(paused, 1600))
        assertFalse(privacyNote(paused.isPrivate, null).contains("end-to-end encrypted"))
        assertEquals("Transfer link", linkLabel(paused.isPrivate))
        // Paused with the code still live keeps the dimmed code invitation.
        val early = view.copy(phase = TransferPhase.PAUSED)
        assertEquals("48213", liveCode(early, now))
        assertTrue(shareState(early, now) is ShareState.Offline)
        // Before any code exists a fresh code send is preparing, not expired.
        val fresh = send(TransferPhase.CONNECTING).copy(link = null, code = null, privateLink = null, isPrivate = false, expiresAt = 0)
        assertFalse(codeExpired(fresh, now))
        assertEquals(TransferBody.PREPARING, transferBody(fresh, now))
    }

    @Test fun spentCodeWaitsForTheSameReceiverAndNeverPromisesANewCode() {
        val base = send().copy(link = "https://cd.yash0.in/#48213", code = "48213", privateLink = link, isPrivate = false,
            codeSpent = true, codeExpiresAt = 1500, expiresAt = 90_000, message = "Waiting for the same receiver to resume. The code has already been used.")
        for (phase in listOf(TransferPhase.WAITING, TransferPhase.PAUSED, TransferPhase.CONNECTING)) {
            for (at in listOf(now, 1600)) { // before and after the code TTL
                val view = base.copy(phase = phase)
                assertNull("$phase@$at", liveCode(view, at))
                assertNull("$phase@$at", liveLink(view, at))
                assertNull("$phase@$at", privateOffer(view, at))
                assertEquals("$phase@$at", ShareState.Hidden, shareState(view, at))
                assertFalse("$phase@$at", codeExpired(view, at))
                assertEquals("$phase@$at", TransferBody.PROGRESS, transferBody(view, at))
                assertNotEquals("$phase@$at", "Code expired", transferTitle(view, at))
            }
        }
        assertEquals("Waiting for receiver", transferTitle(base, now))
        assertEquals("Paused", transferTitle(base.copy(phase = TransferPhase.PAUSED), 1600))
        // Spent, paused, code cleared by the engine: still not "no live code".
        assertFalse(codeExpired(base.copy(code = null, link = null, phase = TransferPhase.PAUSED), 1600))
    }

    @Test fun unspentCodeSurvivesReconnectAsTheSameCode() {
        val view = send(TransferPhase.CONNECTING).copy(link = "https://cd.yash0.in/#48213", code = "48213", isPrivate = false, codeExpiresAt = 1500, expiresAt = 90_000)
        val share = shareState(view, now)
        assertTrue(share is ShareState.Offline)
        assertEquals("48213", liveCode(view, now))
        assertEquals("Reconnecting — the code stays the same", offlineLabel(share as ShareState.Offline, code = true))
    }

    @Test fun onlyWaitingPrivateSendsCanGoToATrustedComputer() {
        val view = send().copy(link = null, privateLink = link)
        assertNull(liveCode(view, now))
        assertEquals(link, liveLink(view, now))
        assertEquals(link, privateOffer(view, now))
        assertEquals("cdx receive $link", receiveCommand(link, null))
        assertTrue(privacyNote(true, null).contains("end-to-end"))
        for (phase in listOf(TransferPhase.PAUSED, TransferPhase.CONNECTING, TransferPhase.RETRYING, TransferPhase.PREPARING))
            assertNull(phase.name, privateOffer(view.copy(phase = phase), now))
        assertNull(privateOffer(view.copy(done = 5, phase = TransferPhase.TRANSFERRING), now))
        assertNull(privateOffer(view.copy(direction = Direction.RECEIVE), now))
    }

    @Test fun onlyCompleteCodesSubmitThemselvesWhileTyping() {
        assertTrue(autoSubmittable("48213"))
        assertTrue(autoSubmittable(" 48213 "))
        assertTrue(autoSubmittable("https://cd.yash0.in/#48213"))
        assertFalse(autoSubmittable("https://cd.yash0.in/#"))
        assertFalse(autoSubmittable("https://cd.yash0.in/#4821"))
        assertFalse(autoSubmittable("https://cd.yash0.in/s/abc#v2.partial"))
        assertFalse(autoSubmittable("cdpair:abc"))
        assertFalse(autoSubmittable("4821"))
        assertFalse(autoSubmittable("482134"))
    }
}
