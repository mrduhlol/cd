package `in`.yash0.cd

import org.junit.Assert.*
import org.junit.Test
import java.net.UnknownHostException

class SendStatusTest {
    @Test fun acceptedInvitationSurvivesExplicitPauseAndReconnectUntilExpiry() {
        for (phase in listOf(TransferPhase.WAITING, TransferPhase.PAUSED, TransferPhase.CONNECTING, TransferPhase.TRANSFERRING)) {
            assertTrue(SendStatus.linkVisible(true, phase, 200, 100))
            assertFalse(SendStatus.linkVisible(true, phase, 200, 200))
            assertFalse(SendStatus.linkVisible(false, phase, 200, 100))
        }
        for (phase in listOf(TransferPhase.COMPLETE, TransferPhase.CANCELLED, TransferPhase.FAILED))
            assertFalse(SendStatus.linkVisible(true, phase, 200, 100))
    }
    @Test fun restartedSendsRequireExplicitResumeAndEndedSendsStayEnded() {
        assertEquals(TransferPhase.PAUSED, SendStatus.restored("TRANSFERRING"))
        assertEquals(TransferPhase.PAUSED, SendStatus.restored("WAITING"))
        assertEquals(TransferPhase.COMPLETE, SendStatus.restored("COMPLETE"))
        assertFalse(SendStatus.canStop(TransferPhase.COMPLETE, TransferPhase.PAUSED))
        assertFalse(SendStatus.canStop(TransferPhase.FAILED, TransferPhase.PAUSED))
        assertTrue(SendStatus.canStop(TransferPhase.FAILED, TransferPhase.CANCELLED))
    }
    @Test fun errorsGiveFixedActionableGuidanceWithoutExceptionText() {
        assertEquals(SendFailureKind.OFFLINE, SendFailures.classify(UnknownHostException("secret.invalid")))
        assertEquals(SendFailureKind.UNSUPPORTED, SendFailures.http(404))
        assertEquals(SendFailureKind.RATE_LIMITED, SendFailures.http(429))
        assertEquals(SendFailureKind.FINISHED, SendFailures.http(410))
        assertEquals(SendFailureKind.EXPIRED, SendFailures.classify(UnknownHostException(), 10, 10))
        assertFalse(SendFailures.classify(UnknownHostException("private-key")).message.contains("private-key"))
    }
    @Test fun sameRootInTwoDirectionsDoesNotReplaceOrRemoveTheSender() {
        val id = "unit-direction-identity"
        try {
            TransferBus.publish(TransferView(id, Direction.SEND, "file", 1, 0, 0, TransferPhase.WAITING))
            TransferBus.publish(TransferView(id, Direction.RECEIVE, "file", 1, 0, 0, TransferPhase.CONNECTING))
            assertEquals(TransferPhase.WAITING, TransferBus.find(id, Direction.SEND)?.phase)
            assertEquals(TransferPhase.CONNECTING, TransferBus.find(id, Direction.RECEIVE)?.phase)
            TransferBus.remove(id, Direction.RECEIVE)
            assertNotNull(TransferBus.find(id, Direction.SEND))
            assertNull(TransferBus.find(id, Direction.RECEIVE))
        } finally { TransferBus.remove(id) }
    }
}
