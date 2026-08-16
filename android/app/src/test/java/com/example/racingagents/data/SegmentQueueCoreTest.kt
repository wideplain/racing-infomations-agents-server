package com.example.racingagents.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SegmentQueueCoreTest {

    @Test
    fun `clientSeq is assigned sequentially starting from zero`() {
        val core = SegmentQueueCore()
        val first = core.enqueue("hello", isFinal = true, startedAt = 0, endedAt = 1)
        val second = core.enqueue("world", isFinal = true, startedAt = 1, endedAt = 2)

        assertEquals(0L, first.clientSeq)
        assertEquals(1L, second.clientSeq)
        assertEquals(2, core.size)
    }

    @Test
    fun `ack removes only the acknowledged segments`() {
        val core = SegmentQueueCore()
        val a = core.enqueue("a", true, 0, 1)
        core.enqueue("b", true, 1, 2)
        val c = core.enqueue("c", true, 2, 3)

        core.ack(listOf(a.clientSeq, c.clientSeq))

        assertEquals(1, core.size)
        assertEquals("b", core.snapshot().single().text)
    }

    @Test
    fun `peekBatch caps at the requested max without removing entries`() {
        val core = SegmentQueueCore()
        repeat(25) { core.enqueue("seg$it", true, 0, 0) }

        val batch = core.peekBatch(20)

        assertEquals(20, batch.size)
        assertEquals(25, core.size) // peek must not drain the queue
        assertEquals(0L, batch.first().clientSeq)
        assertEquals(19L, batch.last().clientSeq)
    }

    @Test
    fun `restore resumes seq numbering above the highest restored clientSeq`() {
        val core = SegmentQueueCore()
        core.restore(
            listOf(
                PendingSegment(clientSeq = 5, text = "x", isFinal = true, startedAt = 0, endedAt = 0),
                PendingSegment(clientSeq = 7, text = "y", isFinal = true, startedAt = 0, endedAt = 0),
            ),
        )

        val next = core.enqueue("z", true, 0, 0)

        assertEquals(8L, next.clientSeq)
        assertEquals(3, core.size)
    }

    @Test
    fun `restore does not regress seq numbering below what was already assigned`() {
        val core = SegmentQueueCore()
        core.enqueue("a", true, 0, 0) // seq 0
        core.enqueue("b", true, 0, 0) // seq 1
        core.restore(listOf(PendingSegment(clientSeq = 0, text = "a", isFinal = true, startedAt = 0, endedAt = 0)))

        val next = core.enqueue("c", true, 0, 0)

        assertTrue(next.clientSeq >= 2L)
    }

    @Test
    fun `backoff grows exponentially from 1s and caps at 30s`() {
        assertEquals(0L, computeBackoffMillis(0))
        assertEquals(1000L, computeBackoffMillis(1))
        assertEquals(2000L, computeBackoffMillis(2))
        assertEquals(4000L, computeBackoffMillis(3))
        assertEquals(16000L, computeBackoffMillis(5))
        assertEquals(30000L, computeBackoffMillis(6)) // 32s would exceed the cap
        assertEquals(30000L, computeBackoffMillis(20))
    }
}
