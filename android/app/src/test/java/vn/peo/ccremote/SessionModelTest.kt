package vn.peo.ccremote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import vn.peo.ccremote.session.Haptic
import vn.peo.ccremote.session.SessionModel
import vn.peo.ccremote.session.pendingPermission

class SessionModelTest {
    private val sid = "11111111-2222-3333-4444-555555555555"

    private fun state(status: String = "idle", epoch: String = "e1", extra: String = "") =
        """{"kind":"state","id":"$sid","status":"$status","epoch":"$epoch","pending":0,"live":true,"mode":"default","updatedAt":1,"lastSeq":0$extra}"""

    @Test fun `sự kiện trùng hoặc cũ hơn seq đã nhận bị bỏ`() {
        val m = SessionModel(sid)
        m.handle("""{"kind":"user","seq":1,"text":"a"}""")
        m.handle("""{"kind":"assistant","seq":2,"text":"b"}""")
        m.handle("""{"kind":"assistant","seq":2,"text":"b lặp"}""")
        m.handle("""{"kind":"assistant","seq":1,"text":"cũ"}""")
        m.handle("""{"kind":"assistant","seq":3,"text":"c"}""")
        assertEquals(listOf(1, 2, 3), m.events.map { it.seq })
        assertEquals(3, m.lastSeq)
        assertEquals(3, m.scrollTick)
    }

    @Test fun `state ghi epoch để nối lại với after và epoch hiện có`() {
        val m = SessionModel(sid)
        m.handle("""{"kind":"assistant","seq":1,"text":"x"}""")
        m.handle(state(epoch = "abc"))
        assertEquals("abc", m.epoch)
        assertEquals(1, m.lastSeq)
        assertEquals("idle", m.status)
    }

    @Test fun `reset xoá hết và đặt epoch mới`() {
        val m = SessionModel(sid)
        m.handle("""{"kind":"user","seq":1,"text":"a"}""")
        m.handle("""{"kind":"tool_result","seq":2,"id":"t1","text":"ok"}""")
        m.handle("""{"kind":"decided","seq":3,"requestId":"r1","decision":"allow"}""")
        m.handle("""{"kind":"reset","epoch":"e2"}""")
        assertTrue(m.events.isEmpty())
        assertTrue(m.toolResults.isEmpty())
        assertTrue(m.decisions.isEmpty())
        assertEquals(0, m.lastSeq)
        assertEquals("e2", m.epoch)
        // sau reset seq bắt đầu lại từ 1 phải nhận được
        m.handle("""{"kind":"user","seq":1,"text":"mới"}""")
        assertEquals(1, m.events.size)
    }

    @Test fun `visible gộp kết quả tool và ẩn dòng tool đã có thẻ duyệt quyền`() {
        val m = SessionModel(sid)
        m.handle("""{"kind":"tool","seq":1,"id":"t1","name":"Bash","summary":"ls"}""")
        m.handle("""{"kind":"tool_result","seq":2,"id":"t1","text":"out"}""")
        m.handle("""{"kind":"tool","seq":3,"id":"t2","name":"Write","summary":"a.txt"}""")
        m.handle("""{"kind":"permission","seq":4,"requestId":"r1","tool":"Write","toolUseId":"t2"}""")
        m.handle("""{"kind":"decided","seq":5,"requestId":"r1","decision":"allow","text":"ok nhé"}""")
        assertEquals(listOf(1, 4), m.visible.map { it.seq })   // tool_result, decided và tool t2 bị ẩn
        assertEquals("out", m.toolResults["t1"]!!.text)
        assertEquals("allow", m.decisions["r1"])
        assertEquals("ok nhé", m.decisionTexts["r1"])
    }

    @Test fun `trạng thái chạy và nghĩ`() {
        val m = SessionModel(sid)
        m.handle(state("running"))
        assertTrue(m.isBusy)
        m.handle("""{"kind":"progress","phase":"thinking","tokens":420}""")
        assertEquals(420, m.thinkingTokens)
        m.handle("""{"kind":"progress","phase":"working"}""")
        assertNull(m.thinkingTokens)
        m.handle(state("idle"))
        assertFalse(m.isBusy)
        m.handle(state("waiting"))
        assertTrue(m.isBusy)
        assertEquals("off", SessionModel(sid).status)
    }

    @Test fun `rung khi xin quyền, hết hạn mức và xong lượt thành công`() {
        val got = ArrayList<Haptic>()
        val m = SessionModel(sid) { got.add(it) }
        m.handle("""{"kind":"permission","seq":1,"requestId":"r1","tool":"Bash"}""")
        m.handle("""{"kind":"limit","seq":2,"text":"hết"}""")
        m.handle("""{"kind":"result","seq":3,"ok":true}""")
        m.handle("""{"kind":"result","seq":4,"ok":false}""")
        assertEquals(listOf(Haptic.Warning, Haptic.Warning, Haptic.Success), got)
    }

    @Test fun `json hỏng hoặc kind lạ không làm vỡ`() {
        val m = SessionModel(sid)
        m.handle("không phải json")
        m.handle("[1,2]")
        m.handle("""{"kind":"future_kind","seq":1,"x":1}""")
        assertEquals(1, m.events.size)
    }

    @Test fun `yêu cầu quyền đang chờ là permission chưa có decided`() {
        val m = SessionModel(sid)
        m.handle("""{"kind":"permission","seq":1,"requestId":"r1","tool":"Write"}""")
        m.handle("""{"kind":"decided","seq":2,"requestId":"r1","decision":"deny"}""")
        m.handle("""{"kind":"permission","seq":3,"requestId":"r2","tool":"Bash"}""")
        assertEquals("r2", pendingPermission(m.events)!!.requestId)
        m.handle("""{"kind":"decided","seq":4,"requestId":"r2","decision":"allow"}""")
        assertNull(pendingPermission(m.events))
        assertNotNull(m.events)
    }
}
